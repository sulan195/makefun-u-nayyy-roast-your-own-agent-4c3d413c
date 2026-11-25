// Tests for the roast entry: gate (1-200 chars, UTF-8, single line),
// determinism, output-dir handling, and the edge cases from Fase 2.
// Run: node --test tests/test_roast.mjs  (Node 22, stdlib only)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ROAST,
  roastLine,
  validateLine,
  outputDir,
  writeEntry,
} from "../main.ts";

const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

function tempDir() {
  return mkdtempSync(join(tmpdir(), "roast-test-"));
}

test("roast line passes the gate: 1-200 characters, UTF-8, one line", () => {
  const line = roastLine();
  assert.equal(typeof line, "string");
  assert.ok(line.length >= 1 && line.length <= 200, `chars=${line.length}`);
  assert.equal(line.trim(), line, "no surrounding whitespace");
  assert.ok(!line.includes("\n") && !line.includes("\r"), "single line");
  // Strict UTF-8 round-trip.
  const bytes = Buffer.from(line, "utf8");
  assert.equal(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    line,
  );
  // ASCII keeps the byte count (the leaderboard Size tie-break) minimal.
  assert.equal(bytes.length, line.length, "ASCII: bytes == chars");
  assert.ok(bytes.length <= 200);
  validateLine(line);
});

test("validateLine rejects the Fase 2 edge cases", () => {
  assert.throws(() => validateLine(""), /1-200/);
  assert.throws(() => validateLine("x".repeat(201)), /1-200/);
  assert.throws(() => validateLine(" padded "), /whitespace/);
  assert.throws(() => validateLine("two\nlines"), /single line/);
  assert.throws(() => validateLine("carriage\rreturn"), /single line/);
  // Whitespace-only strings are covered by the gate's "not only whitespace"
  // rule even though they are inside the 1-200 length range.
  assert.throws(() => validateLine("   "), /whitespace/);
  assert.throws(() => validateLine("\t"), /control|whitespace/);
  assert.throws(() => validateLine(" x"), /whitespace/);
  assert.throws(() => validateLine("x "), /whitespace/);
  // Interior tab and Unicode line/paragraph separators.
  assert.throws(() => validateLine("a\tb"), /control/);
  assert.throws(() => validateLine("a\u2028b"), /control/);
  // A lone surrogate passes length checks but writeFileSync would silently
  // substitute U+FFFD for it, so the validator must reject it.
  assert.throws(() => validateLine("a\uD800b"), /well-formed/);
  // Inclusive pass boundaries: 1 char and exactly 200 chars/bytes.
  validateLine("x");
  validateLine("x".repeat(200));
  // 201 bytes of 2-byte characters is 101 chars: inside the char gate but
  // over the byte cap the entry enforces for the Size tie-break.
  assert.throws(() => validateLine("é".repeat(101)), /200 bytes/);
});

test("outputDir prefers MAKEFUN_OUTPUT_DIR, falls back to /output", () => {
  const saved = process.env.MAKEFUN_OUTPUT_DIR;
  try {
    process.env.MAKEFUN_OUTPUT_DIR = "/tmp/somewhere";
    assert.equal(outputDir(), "/tmp/somewhere");
    process.env.MAKEFUN_OUTPUT_DIR = "   ";
    assert.equal(outputDir(), "/output");
    process.env.MAKEFUN_OUTPUT_DIR = "";
    assert.equal(outputDir(), "/output");
    process.env.MAKEFUN_OUTPUT_DIR = "  /tmp/padded  ";
    assert.equal(outputDir(), "/tmp/padded");
    delete process.env.MAKEFUN_OUTPUT_DIR;
    assert.equal(outputDir(), "/output");
  } finally {
    if (saved === undefined) delete process.env.MAKEFUN_OUTPUT_DIR;
    else process.env.MAKEFUN_OUTPUT_DIR = saved;
  }
});

test("writeEntry creates a missing output dir and writes exactly the line", () => {
  const dir = tempDir();
  try {
    const nested = join(dir, "deep", "out");
    const file = writeEntry(nested);
    assert.equal(file, join(nested, "entry.txt"));
    const bytes = readFileSync(file);
    assert.equal(bytes.toString("utf8"), ROAST);
    assert.equal(bytes.length, Buffer.byteLength(ROAST, "utf8"));
    assert.ok(!bytes.toString("utf8").endsWith("\n"), "no trailing newline");
    assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), "no BOM");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeEntry overwrites a stale longer entry.txt and treats empty dir as fallback", () => {
  const dir = tempDir();
  const saved = process.env.MAKEFUN_OUTPUT_DIR;
  try {
    // Stale longer file: the write must truncate, not append or leave bytes.
    const stale = join(dir, "entry.txt");
    execFileSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(stale)}, "x".repeat(500))`], { stdio: "pipe" });
    writeEntry(dir);
    assert.equal(readFileSync(stale, "utf8"), ROAST);
    // Empty / whitespace-only dir falls back to the env directory.
    process.env.MAKEFUN_OUTPUT_DIR = dir;
    assert.equal(writeEntry(""), join(dir, "entry.txt"));
    assert.equal(writeEntry("   "), join(dir, "entry.txt"));
    assert.equal(readFileSync(stale, "utf8"), ROAST);
  } finally {
    if (saved === undefined) delete process.env.MAKEFUN_OUTPUT_DIR;
    else process.env.MAKEFUN_OUTPUT_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness run works as relative 'node main.ts' from the repo root", () => {
  const dir = tempDir();
  try {
    const out = join(dir, "out");
    const repoRoot = join(MAIN, "..");
    execFileSync("node", ["main.ts"], {
      cwd: repoRoot,
      env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
      stdio: "pipe",
    });
    assert.equal(readFileSync(join(out, "entry.txt"), "utf8"), ROAST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness run works with an absolute path from an unrelated cwd", () => {
  const dir = tempDir();
  try {
    const out = join(dir, "out");
    execFileSync("node", [MAIN], {
      cwd: dir,
      env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
      stdio: "pipe",
    });
    assert.equal(readFileSync(join(out, "entry.txt"), "utf8"), ROAST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness run is deterministic: two runs, byte-identical output", () => {
  const a = tempDir();
  const b = tempDir();
  try {
    for (const dir of [a, b]) {
      execFileSync("node", [MAIN], {
        env: { ...process.env, MAKEFUN_OUTPUT_DIR: dir },
        stdio: "pipe",
      });
    }
    const bytesA = readFileSync(join(a, "entry.txt"));
    const bytesB = readFileSync(join(b, "entry.txt"));
    assert.deepEqual(bytesA, bytesB);
    assert.equal(bytesA.toString("utf8"), ROAST);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("harness run works through a symlink to main.ts", () => {
  const dir = tempDir();
  try {
    const link = join(dir, "link-main.ts");
    execFileSync("ln", ["-s", MAIN, link], { stdio: "pipe" });
    const out = join(dir, "out");
    execFileSync("node", [link], {
      env: { ...process.env, MAKEFUN_OUTPUT_DIR: out },
      stdio: "pipe",
    });
    assert.equal(readFileSync(join(out, "entry.txt"), "utf8"), ROAST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harness run fails loudly when the output path is a file", () => {
  const dir = tempDir();
  try {
    const blocker = join(dir, "blocker");
    execFileSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(blocker)}, "x")`], { stdio: "pipe" });
    const run = spawnSync("node", [MAIN], {
      env: { ...process.env, MAKEFUN_OUTPUT_DIR: blocker },
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0, "must exit non-zero");
    assert.ok(existsSync(blocker), "blocker file untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
