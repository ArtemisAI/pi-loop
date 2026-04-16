/**
 * Sandbox install verification.
 *
 * Runs npm pack, installs into an isolated directory, and verifies the
 * package structure is correct for pi-agent consumption.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PACKAGE_DIR = join(import.meta.dirname, "../..");

beforeAll(() => {
  execSync("npm run build", { cwd: PACKAGE_DIR, stdio: "pipe" });
});

describe("Sandbox install verification", () => {
  it("npm pack produces a valid tarball", () => {
    // npm pack --dry-run prints the file listing to stderr, filename to stdout
    const output = execSync("npm pack --dry-run 2>&1", {
      cwd: PACKAGE_DIR,
      encoding: "utf-8",
    });

    // Core files present
    expect(output).toContain("dist/index.js");
    expect(output).toContain("dist/index.d.ts");
    expect(output).toContain("dist/cron.js");
    expect(output).toContain("dist/scheduler.js");
    expect(output).toContain("dist/store.js");
    expect(output).toContain("dist/tools/cron-tools.js");
    expect(output).toContain("LICENSE");
    expect(output).toContain("README.md");
    expect(output).toContain("config/default.json");

    // Skills included
    expect(output).toContain("skills/loop/SKILL.md");
    expect(output).toContain("skills/schedule/SKILL.md");

    // Source and tests excluded
    expect(output).not.toContain("src/");
    expect(output).not.toContain("tests/");
    expect(output).not.toContain(".claude/");
    expect(output).not.toContain("tsconfig.json");
  });

  it("installs cleanly in a sandbox", () => {
    const tarball = execSync("npm pack", {
      cwd: PACKAGE_DIR,
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .pop()!
      .trim();
    const tarballPath = join(PACKAGE_DIR, tarball);

    const sandbox = mkdtempSync(join(tmpdir(), "pi-loop-sandbox-"));
    try {
      copyFileSync(tarballPath, join(sandbox, tarball));

      writeFileSync(
        join(sandbox, "package.json"),
        JSON.stringify({
          name: "test-sandbox",
          private: true,
          type: "module",
          dependencies: { "@pi-agents/loop": `file:./${tarball}` },
        }),
      );

      execSync("npm install", { cwd: sandbox, stdio: "pipe" });

      const pkgDir = join(sandbox, "node_modules/@pi-agents/loop");
      expect(existsSync(pkgDir)).toBe(true);
      expect(existsSync(join(pkgDir, "dist/index.js"))).toBe(true);
      expect(existsSync(join(pkgDir, "dist/index.d.ts"))).toBe(true);
      expect(existsSync(join(pkgDir, "dist/cron.js"))).toBe(true);
      expect(existsSync(join(pkgDir, "dist/scheduler.js"))).toBe(true);
      expect(existsSync(join(pkgDir, "dist/store.js"))).toBe(true);
      expect(existsSync(join(pkgDir, "dist/tools/cron-tools.js"))).toBe(true);
      expect(existsSync(join(pkgDir, "skills/loop/SKILL.md"))).toBe(true);
      expect(existsSync(join(pkgDir, "skills/schedule/SKILL.md"))).toBe(true);

      // Verify pi manifest
      const pkg = JSON.parse(
        readFileSync(join(pkgDir, "package.json"), "utf-8"),
      );
      expect(pkg.pi.extensions).toContain("./dist/index.js");
      expect(pkg.pi.skills).toContain("./skills");

      // No source leaked
      expect(existsSync(join(pkgDir, "src"))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
      if (existsSync(tarballPath)) rmSync(tarballPath);
    }
  }, 60_000);
});
