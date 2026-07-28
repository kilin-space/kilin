import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { maybeOfferAgentSkillsLinkSetup, runSkillsCommand } from "../../src/cli/skills-commands.js";
import { nodeAgentSkillsPorts } from "../../src/infrastructure/agent-skills-ports.js";
import { isCommandFailure } from "../helpers/subprocess.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const temporaryDirectories: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-skills-cli-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
};

const runCli = async (
  arguments_: string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<CliResult> => {
  try {
    const result = await execFileAsync(process.execPath, [cliFile, ...arguments_], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("skills CLI", () => {
  it("links only the requested provider and records setup preference", async () => {
    const root = await createTemporaryDirectory();
    const homeDirectory = join(root, "home");
    const dataDirectory = join(root, "data");

    const linked = await runCli(
      ["skills", "link", "--providers", "agents", "--home", homeDirectory],
      { KILIN_DATA_DIR: dataDirectory },
    );
    const status = await runCli(["skills", "status", "--json", "--home", homeDirectory], {
      KILIN_DATA_DIR: dataDirectory,
    });
    const preference = JSON.parse(await readFile(join(dataDirectory, "setup.json"), "utf8")) as {
      agentSkillsLink: { providers: string[] };
    };
    const document = JSON.parse(status.stdout) as {
      preference: { providers: string[] } | null;
      providers: { provider: string; skills: { status: string }[] }[];
    };

    expect(linked).toMatchObject({ exitCode: 0, stderr: "" });
    expect(linked.stdout).toContain("agents");
    expect(status.exitCode).toBe(0);
    expect(preference.agentSkillsLink.providers).toEqual(["agents"]);
    expect(document.preference?.providers).toEqual(["agents"]);
    const agents = document.providers.find((provider) => provider.provider === "agents");
    const claude = document.providers.find((provider) => provider.provider === "claude");
    expect(agents?.skills.every((skill) => skill.status === "ok")).toBe(true);
    expect(claude?.skills.every((skill) => skill.status === "missing")).toBe(true);
    for (const skillName of [
      "generate-kilin-workflow",
      "discover-kilin-workflows",
      "run-kilin-workflow",
    ]) {
      expect(
        (await lstat(join(homeDirectory, ".agents", "skills", skillName))).isSymbolicLink(),
      ).toBe(true);
    }
  });

  it("does not change any provider when a destination conflicts", async () => {
    const root = await createTemporaryDirectory();
    const homeDirectory = join(root, "home");
    const dataDirectory = join(root, "data");

    await mkdir(join(homeDirectory, ".claude", "skills", "discover-kilin-workflows"), {
      recursive: true,
    });

    const result = await runCli(
      ["skills", "link", "--providers", "agents,claude", "--home", homeDirectory],
      { KILIN_DATA_DIR: dataDirectory },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Refusing to replace an existing non-link path");
    for (const skillName of [
      "generate-kilin-workflow",
      "discover-kilin-workflows",
      "run-kilin-workflow",
    ]) {
      await expect(
        lstat(join(homeDirectory, ".agents", "skills", skillName)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("requires --providers when skill linking is non-interactive", async () => {
    const result = await runCli(["skills", "link", "--home", await createTemporaryDirectory()], {
      KILIN_DATA_DIR: await createTemporaryDirectory(),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--providers");
  });

  it("reports filesystem link failures as operational errors", async () => {
    const root = await createTemporaryDirectory();
    const homeFile = join(root, "not-a-directory");
    await writeFile(homeFile, "file");

    const result = await runCli(["skills", "link", "--providers", "agents", "--home", homeFile], {
      KILIN_DATA_DIR: join(root, "data"),
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("INTERNAL_ERROR");
    expect(result.stderr).toContain("Agent skill linking failed.");
    expect(result.stderr).not.toContain("OPTION_INVALID");
  });

  it("prints a non-TTY hint when setup preference is missing", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const dataDirectory = await createTemporaryDirectory();
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      await maybeOfferAgentSkillsLinkSetup({
        command: "workflow",
        json: false,
        dependencies: {
          ports: nodeAgentSkillsPorts,
          stdinIsTty: false,
          stdoutIsTty: false,
          homeDirectory,
          dataDirectory,
          packageRoot,
        },
      });
      await maybeOfferAgentSkillsLinkSetup({
        command: "workflow",
        json: false,
        dependencies: {
          ports: nodeAgentSkillsPorts,
          stdinIsTty: false,
          stdoutIsTty: false,
          homeDirectory,
          dataDirectory,
          packageRoot,
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toContain("kilin skills link");
  });

  it("does not treat the Vitest environment variable as a setup-prompt preference", async () => {
    const result = await runCli(["workflow", "list", "--json"], {
      KILIN_DATA_DIR: await createTemporaryDirectory(),
      KILIN_SKIP_SETUP_PROMPT: "",
      VITEST: "true",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("kilin skills link");
  });

  it("runs the requested command when the recorded setup preference is unreadable", async () => {
    const dataDirectory = await createTemporaryDirectory();
    await writeFile(join(dataDirectory, "setup.json"), "{ not json", "utf8");

    const result = await runCli(["workflow", "list", "--json"], {
      KILIN_DATA_DIR: dataDirectory,
      KILIN_SKIP_SETUP_PROMPT: "",
    });
    const document = JSON.parse(result.stdout) as { outputVersion: number };

    expect(result.exitCode).toBe(0);
    expect(document.outputVersion).toBe(1);
    expect(result.stderr).toContain("setup.json");
  });

  it("runs the requested command when first-run linking hits an occupied skill path", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const dataDirectory = await createTemporaryDirectory();
    await mkdir(join(homeDirectory, ".claude", "skills", "generate-kilin-workflow"), {
      recursive: true,
    });
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;

    try {
      await maybeOfferAgentSkillsLinkSetup({
        command: "run",
        json: false,
        dependencies: {
          ports: nodeAgentSkillsPorts,
          stdinIsTty: true,
          stdoutIsTty: true,
          homeDirectory,
          dataDirectory,
          packageRoot,
          prompt: () => Promise.resolve({ kind: "selected" as const, providers: ["claude"] }),
        },
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrChunks.join("")).toContain("Skipped agent skill setup");
  });

  it("persists an empty provider selection from the interactive prompt", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const dataDirectory = await createTemporaryDirectory();

    const exitCode = await runSkillsCommand(["link"], {
      ports: nodeAgentSkillsPorts,
      stdinIsTty: true,
      stdoutIsTty: true,
      homeDirectory,
      dataDirectory,
      packageRoot,
      prompt: () => Promise.resolve({ kind: "selected" as const, providers: [] }),
    });
    const preference = JSON.parse(await readFile(join(dataDirectory, "setup.json"), "utf8")) as {
      agentSkillsLink: { providers: string[] };
    };

    expect(exitCode).toBe(0);
    expect(preference.agentSkillsLink.providers).toEqual([]);
  });

  it("reports empty-provider preference failures as operational errors", async () => {
    const root = await createTemporaryDirectory();
    const dataFile = join(root, "not-a-directory");
    await writeFile(dataFile, "file");

    await expect(
      runSkillsCommand(["link"], {
        ports: nodeAgentSkillsPorts,
        stdinIsTty: true,
        stdoutIsTty: true,
        homeDirectory: join(root, "home"),
        dataDirectory: dataFile,
        packageRoot,
        prompt: () => Promise.resolve({ kind: "selected" as const, providers: [] }),
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  it("skips the first-run prompt once a preference exists", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const dataDirectory = await createTemporaryDirectory();
    let promptCalls = 0;

    await runSkillsCommand(["link", "--providers", "claude"], {
      ports: nodeAgentSkillsPorts,
      homeDirectory,
      dataDirectory,
      packageRoot,
    });

    await maybeOfferAgentSkillsLinkSetup({
      command: "workflow",
      json: false,
      dependencies: {
        ports: nodeAgentSkillsPorts,
        stdinIsTty: true,
        stdoutIsTty: true,
        homeDirectory,
        dataDirectory,
        packageRoot,
        prompt: () => {
          promptCalls += 1;
          return Promise.resolve({ kind: "selected" as const, providers: ["agents"] });
        },
      },
    });

    expect(promptCalls).toBe(0);
  });
});

describe("skills help", () => {
  it("documents skills link and status", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("kilin skills link");
    expect(help.stdout).toContain("kilin skills status");
  });

  it("does not run first-use setup for subcommand help", async () => {
    const result = await runCli(["workflow", "--help"], {
      KILIN_DATA_DIR: await createTemporaryDirectory(),
      KILIN_SKIP_SETUP_PROMPT: "",
    });

    expect(result.stderr).not.toContain("Agent skills are not linked yet");
  });
});
