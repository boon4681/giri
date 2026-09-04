import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import semver from "semver";

const root = join(import.meta.dirname, "..");
const draftDir = join(root, "changelogs", "draft");
const draftFile = join(draftDir, "changelogs.txt");
const packageFile = join(root, "package.json");

const DRAFT_TEMPLATE = [
    '# One change per line, prefixed with "-". Lines starting with "#" are ignored.',
    "# Entries are markdown: **bold**, [link](url), image ![alt](./file.png), video ![alt](./clip.mp4).",
    "# Put media files next to this file; ./name resolves to this folder and moves with it on publish.",
    '# A line without a "-" continues the entry above it, e.g. a media line under its entry.',
    "# Publish with: yarn changelog publish <version>",
    "",
].join("\n");

function parseEntries(raw: string) {
    const entries: string[] = [];
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) continue;
        const entry = /^- (.*)$/.exec(trimmed);
        if (entry) entries.push(entry[1]);
    }
    return entries;
}

function fail(message: string) {
    console.error(message);
    process.exit(1);
}

function readPackage() {
    return JSON.parse(readFileSync(packageFile, "utf8")) as { version: string } & Record<string, unknown>;
}

function draft() {
    if (existsSync(draftFile)) {
        console.log(`Draft already exists: ${draftFile}`);
        return;
    }
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(draftFile, DRAFT_TEMPLATE);
    console.log(`Created ${draftFile}`);
}

function publish(version: string | undefined) {
    if (!version || !semver.valid(version)) {
        fail("Usage: changelog publish <version>  (version must be valid semver, e.g. 0.0.2)");
        return
    }
    if (!existsSync(draftFile)) {
        fail(`No draft found at ${draftFile}. Run "yarn changelog draft" first.`);
    }

    const entries = parseEntries(readFileSync(draftFile, "utf8"));
    if (!entries.length) {
        fail('The draft has no entries. Add at least one line starting with "- ".');
    }

    const pkg = readPackage();
    if (!semver.gt(version, pkg.version)) {
        fail(`Version ${version} must be greater than the current package version ${pkg.version}.`);
    }

    const versionDir = join(root, "changelogs", version);
    if (existsSync(versionDir)) {
        fail(`changelogs/${version} already exists.`);
    }

    // Move the whole folder so media files referenced by entries travel with the text.
    renameSync(draftDir, versionDir);

    pkg.version = version;
    writeFileSync(packageFile, JSON.stringify(pkg, null, "    ") + "\n");

    console.log(`Published changelogs/${version}/changelogs.txt (${entries.length} entries)`);
    console.log(`package.json version -> ${version}`);
}

const [command, argument] = process.argv.slice(2);
if (command === "draft") draft();
else if (command === "publish") publish(argument);
else fail("Usage: changelog <draft | publish <version>>");
