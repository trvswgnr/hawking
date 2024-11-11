#!/usr/bin/env bun

import { promises as fs } from "fs";
import path from "path";
import inquirer from "inquirer";
import chalk from "chalk";
import { filesize } from "filesize";
import ora, { type Ora } from "ora";
import readline from "readline";

interface ProjectInfo {
  path: string;
  size: number;
}

// Store active spinner for cleanup
let activeSpinner: Ora | null = null;

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

async function findNodeModules(
  startPath: string,
  results: ProjectInfo[] = []
): Promise<ProjectInfo[]> {
  try {
    const files = await fs.readdir(startPath, { withFileTypes: true });

    for (const file of files) {
      const fullPath = path.join(startPath, file.name);

      if (file.isDirectory()) {
        if (file.name === "node_modules") {
          const size = await getDirectorySize(fullPath);
          results.push({
            path: path.dirname(fullPath),
            size,
          });
        } else if (!file.name.startsWith(".") && file.name !== "node_modules") {
          await findNodeModules(fullPath, results);
        }
      }
    }
  } catch (error) {
    console.error(`Error searching in ${startPath}:`, error);
  }

  return results;
}

async function deleteNodeModules(projectPath: string): Promise<void> {
  const nodeModulesPath = path.join(projectPath, "node_modules");
  await fs.rm(nodeModulesPath, { recursive: true, force: true });
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
  console.log("\n"); // Add a newline for cleaner output
  process.exit(0);
}

// Handle various exit signals
function setupCleanup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("SIGINT", () => {
    handleExit();
  });

  // Close readline interface
  rl.close();

  const signals = ["SIGTERM", "SIGQUIT", "beforeExit", "exit"];
  signals.forEach((signal) => {
    process.on(signal, handleExit);
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    console.error("\nAn unexpected error occurred:", error);
    handleExit();
  });
}

async function main() {
  // make sure cursor is shown on startup
  showCursor();

  setupCleanup();

  console.log(chalk.blue.bold("\n🧹 Node Modules Cleaner\n"));

  activeSpinner = ora({
    text: "Searching for node_modules directories...",
    hideCursor: true,
  }).start();

  const projects = await findNodeModules(process.cwd());

  activeSpinner.stop();
  activeSpinner = null;

  // make sure cursor is shown after spinner
  showCursor();

  if (projects.length === 0) {
    console.log(chalk.yellow("\nNo node_modules directories found."));
    return;
  }

  const choices = projects.map((project) => ({
    name: `${chalk.green(project.path)} ${chalk.gray(
      `(${filesize(project.size)})`
    )}`,
    value: project.path,
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
          "Are you sure you want to delete the selected node_modules directories?"
        ),
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("\nOperation cancelled."));
      return;
    }

    activeSpinner = ora({
      text: "Deleting selected node_modules...",
      hideCursor: true,
    }).start();

    try {
      await Promise.all(selectedProjects.map(deleteNodeModules));
      activeSpinner.succeed(
        "Successfully deleted selected node_modules directories."
      );
    } catch (error) {
      activeSpinner.fail("Error deleting node_modules directories:");
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

main().catch((error) => {
  console.error("\nAn unexpected error occurred:", error);
  cleanup();
  process.exit(1);
});