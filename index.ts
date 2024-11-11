#!/usr/bin/env bun

import { promises as fs } from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { filesize } from "filesize";
import ora, { type Ora } from "ora";
import readline from "readline";

// store active spinner for cleanup
let activeSpinner: Ora | null = null;

main().catch((error) => {
  console.error("\nAn unexpected error occurred:", error);
  cleanup();
  process.exit(1);
});

interface ProjectInfo {
  path: string;
  nice_path: string;
  size: number;
  type: "node" | "rust";
}

// make sure cursor is visible
function showCursor() {
  process.stdout.write("\x1B[?25h");
}

async function getDirectorySize(dirPath: string): Promise<number> {
  let size = 0;

  try {
    const files = await fs.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
      const filePath = path.join(dirPath, file.name);

      if (file.isDirectory()) {
        size += await getDirectorySize(filePath);
      } else {
        const stat = await fs.stat(filePath);
        size += stat.size;
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
  }

  return size;
}

async function isRustProject(dirPath: string): Promise<boolean> {
  try {
    const files = await fs.readdir(dirPath);
    return files.includes("Cargo.toml");
  } catch {
    return false;
  }
}

async function findBuildDirectories(
  startPath: string,
  results: ProjectInfo[] = []
): Promise<ProjectInfo[]> {
  try {
    const files = await fs.readdir(startPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(startPath, file.name);

      if (file.isDirectory()) {
        // check for node_modules
        if (file.name === "node_modules") {
          const size = await getDirectorySize(fullPath);
          results.push({
            path: path.dirname(fullPath),
            nice_path: path.dirname(fullPath).replace(getHomeDirectory(), "~"),
            size,
            type: "node",
          });
        }
        // check for rust target directory
        else if (
          file.name === "target" &&
          (await isRustProject(path.dirname(fullPath)))
        ) {
          const size = await getDirectorySize(fullPath);
          results.push({
            path: path.dirname(fullPath),
            nice_path: path.dirname(fullPath).replace(getHomeDirectory(), "~"),
            size,
            type: "rust",
          });
        }
        // continue searching if not a special directory
        else if (
          !file.name.startsWith(".") &&
          file.name !== "node_modules" &&
          file.name !== "target"
        ) {
          await findBuildDirectories(fullPath, results);
        }
      }
    }
  } catch (error) {
    console.error(`Error searching in ${startPath}:`, error);
  }

  return results;
}

async function deleteBuildDirectory(
  projectPath: string,
  type: "node" | "rust"
): Promise<void> {
  const dirPath = path.join(
    projectPath,
    type === "node" ? "node_modules" : "target"
  );
  await fs.rm(dirPath, { recursive: true, force: true });
}

function cleanup() {
  if (activeSpinner) {
    activeSpinner.stop();
    activeSpinner = null;
  }
  showCursor();
}

function handleExit() {
  cleanup();
  console.log("\n"); // add a newline for cleaner output
  process.exit(0);
}

function setupCleanup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", () => {
    handleExit();
  });

  // close readline interface
  rl.close();

  const signals = ["SIGTERM", "SIGQUIT", "beforeExit", "exit"];
  signals.forEach((signal) => {
    process.on(signal, handleExit);
  });

  // handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("\nAn unexpected error occurred:", error);
    handleExit();
  });
}

async function main() {
  showCursor();
  setupCleanup();

  console.log(chalk.blue.bold("\n🧹 Project Build Directory Cleaner\n"));
  console.log(
    chalk.gray("Supports Node.js (node_modules) and Rust (target) projects\n")
  );

  activeSpinner = ora({
    text: "Searching for build directories...",
    hideCursor: true,
  }).start();

  const projects = await findBuildDirectories(process.cwd());

  activeSpinner.stop();
  activeSpinner = null;
  showCursor();

  if (projects.length === 0) {
    console.log(chalk.yellow("\nNo build directories found."));
    return;
  }

  const choices = projects.map((project) => ({
    name: `${chalk.green(project.nice_path)} ${chalk.gray(
      `(${filesize(project.size)})`
    )} ${chalk.yellow(`[${project.type}]`)}`,
    value: project,
  }));

  try {
    const { selectedProjects } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selectedProjects",
        message: "Select projects to clean:",
        choices,
        pageSize: 15,
      },
    ]);

    if (selectedProjects.length === 0) {
      console.log(chalk.yellow("\nNo projects selected."));
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: chalk.red(
          `Are you sure you want to delete ${selectedProjects.length} directories?`
        ),
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("\nOperation cancelled."));
      return;
    }

    activeSpinner = ora({
      text: "Deleting selected build directories...",
      hideCursor: true,
    }).start();

    try {
      await Promise.all(
        selectedProjects.map((project: ProjectInfo) =>
          deleteBuildDirectory(project.path, project.type)
        )
      );
      activeSpinner.succeed("Successfully deleted selected build directories.");
    } catch (error) {
      activeSpinner.fail("Error deleting build directories:");
      console.error(error);
    }
  } catch (e) {
    const error =
      e instanceof Error
        ? e
        : new Error(typeof e === "string" ? e : "Unknown error");
    if (error.message !== "User force closed the prompt") {
      console.error("\nAn error occurred:", error);
    }
  } finally {
    cleanup();
  }
}

function getHomeDirectory() {
  return process.env.HOME || process.env.USERPROFILE || "";
}
