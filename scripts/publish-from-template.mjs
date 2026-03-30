import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build as astroBuild } from "astro";
import archiver from "archiver";
import { parse } from "yaml";
import { z } from "zod";

const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const JSON_MANIFEST_FILENAME = "__manifest.json";
const TEMPLATE_DEFAULT_SUBDOMAIN = "example-subdomain";

const SiteConfigSchema = z.object({
  subdomain: z.string().min(3).max(63).regex(SUBDOMAIN_PATTERN),
});

const actionRoot = process.cwd();
const workspaceRoot = process.env.GITHUB_WORKSPACE ?? actionRoot;
const templateDirInput = process.env.TEMPLATE_DIR;
const publishUrl = process.env.PUBLISH_URL;
const publishAudience = process.env.PUBLISH_AUDIENCE;
const rootDomain = process.env.ROOT_DOMAIN;

if (!templateDirInput || !publishUrl || !publishAudience || !rootDomain) {
  throw new Error("Missing one or more required env vars: TEMPLATE_DIR, PUBLISH_URL, PUBLISH_AUDIENCE, ROOT_DOMAIN");
}

const templateDir = path.resolve(workspaceRoot, templateDirInput);

const siteConfigPath = path.join(templateDir, "site.config.yaml");
const templateContentDir = path.join(templateDir, "content");
const starlightDocsDir = path.join(actionRoot, "src", "content", "docs");
const distDir = path.join(actionRoot, "dist");
const distManifestPath = path.join(distDir, JSON_MANIFEST_FILENAME);

async function readSiteConfig() {
  let rawYaml;
  try {
    rawYaml = await readFile(siteConfigPath, "utf8");
  } catch {
    throw new Error(`Missing site config: ${siteConfigPath}`);
  }

  return SiteConfigSchema.parse(parse(rawYaml));
}

async function syncTemplateMarkdown() {
  try {
    await readdir(templateContentDir);
  } catch {
    throw new Error(`Missing content directory: ${templateContentDir}`);
  }

  // Starlight requires docs under src/content/docs; template authors only own /content.
  // https://starlight.astro.build/reference/configuration/#configure-content-collections
  await rm(starlightDocsDir, { recursive: true, force: true });
  await mkdir(path.dirname(starlightDocsDir), { recursive: true });
  await cp(templateContentDir, starlightDocsDir, { recursive: true, force: true });
}

async function writeManifest(subdomain) {
  await mkdir(path.dirname(distManifestPath), { recursive: true });
  await writeFile(distManifestPath, JSON.stringify({ subdomain }, null, 2));
}

async function createBundleBase64() {
  return await new Promise((resolve, reject) => {
    const archive = archiver("zip", {
      zlib: {
        level: 9,
      },
    });
    const chunks = [];

    archive.on("data", (chunk) => {
      chunks.push(chunk);
    });
    archive.on("warning", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }

      reject(error);
    });
    archive.on("error", (error) => {
      reject(error);
    });
    archive.on("end", () => {
      resolve(Buffer.concat(chunks).toString("base64"));
    });

    // Zip the build output with `dist/` contents at archive root.
    // https://www.archiverjs.com/docs/archiver/#directory
    archive.directory(distDir, false);
    archive.finalize();
  });
}

async function requestGitHubOidcToken(audience) {
  if (process.env.PUBLISH_TOKEN) {
    return process.env.PUBLISH_TOKEN;
  }

  // GitHub exposes runner-scoped env vars for job-level OIDC token requests.
  // https://docs.github.com/en/actions/reference/security/oidc#methods-for-requesting-the-oidc-token
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

  if (!requestToken || !requestUrl) {
    throw new Error("GitHub OIDC environment variables are missing");
  }

  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${requestUrl}${separator}audience=${encodeURIComponent(audience)}`,
    {
      headers: {
        Authorization: `bearer ${requestToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to mint GitHub OIDC token (${response.status})`);
  }

  const payload = await response.json();

  if (!payload?.value || typeof payload.value !== "string") {
    throw new Error("GitHub OIDC response did not include a token");
  }

  return payload.value;
}

async function buildAndPublish() {
  const siteConfig = await readSiteConfig();

  // Template repos start with a placeholder subdomain. Skipping here avoids
  // failing first-run workflow executions before the repo owner picks a real value.
  if (siteConfig.subdomain === TEMPLATE_DEFAULT_SUBDOMAIN) {
    console.log(
      `Skipping publish because site.config.yaml uses default subdomain '${TEMPLATE_DEFAULT_SUBDOMAIN}'.`,
    );
    return;
  }

  const siteOrigin = `https://${siteConfig.subdomain}.${rootDomain}`;

  await syncTemplateMarkdown();

  await rm(distDir, { recursive: true, force: true });
  await astroBuild({
    root: actionRoot,
    site: siteOrigin,
  });

  await writeManifest(siteConfig.subdomain);

  const bundleBase64 = await createBundleBase64();
  const token = await requestGitHubOidcToken(publishAudience);

  const response = await fetch(publishUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      manifest: {
        subdomain: siteConfig.subdomain,
      },
      bundle_base64: bundleBase64,
    }),
  });

  const responseText = await response.text();
  let responseBody = null;

  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = { message: responseText };
    }
  }

  if (!response.ok) {
    throw new Error(responseBody?.message ?? `Publish failed with status ${response.status}`);
  }

  console.log(JSON.stringify(responseBody, null, 2));
}

try {
  await buildAndPublish();
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error(error.issues[0]?.message ?? "Invalid site.config.yaml");
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unexpected publish error");
  }

  process.exit(1);
}
