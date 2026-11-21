const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
  isApprovedHistorySmokeTopicCommand,
} = require("./historySmokeTopicPreflight");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE_PATH = path.join(REPOSITORY_ROOT, "docker-compose.v2.yml");
const APPROVED_DOCKER_EXECUTABLE =
  "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const APPROVED_DOCKER_CONTEXT = "desktop-linux";
const APPROVED_DOCKER_DAEMON_ID = "8f8b080b-cc6a-4a2f-b64c-42b3a4fca236";
const DAEMON_ID_ARGS = Object.freeze([
  "--context",
  APPROVED_DOCKER_CONTEXT,
  "info",
  "--format",
  "{{.ID}}",
]);
const EXECUTOR_OPTIONS = Object.freeze({
  encoding: "utf8",
  maxBuffer: HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
  shell: false,
  timeout: HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
});
const EXECUTOR_OPTION_KEYS = Object.freeze([
  "encoding",
  "maxBuffer",
  "shell",
  "timeout",
]);
const DOCKER_ENVIRONMENT_VARIABLES = new Set([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_DEFAULT_PLATFORM",
]);

function isExactApprovedArguments(command, args) {
  if (!isApprovedHistorySmokeTopicCommand(command, args) ||
      Object.keys(args).length !== HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS.length) {
    return false;
  }
  return HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS.every((expected, index) =>
    Object.prototype.hasOwnProperty.call(args, index) &&
    args[index] === expected);
}

function hasExpectedOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return false;
  }
  const keys = Object.keys(options).sort();
  const expectedKeys = [...EXECUTOR_OPTION_KEYS].sort();
  return keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    options.encoding === EXECUTOR_OPTIONS.encoding &&
    options.maxBuffer === EXECUTOR_OPTIONS.maxBuffer &&
    options.shell === EXECUTOR_OPTIONS.shell &&
    options.timeout === EXECUTOR_OPTIONS.timeout;
}

function validateAmbientEnvironment() {
  if (process.platform !== "win32") {
    throw new Error("V2 history smoke Docker execution requires the supported Windows host.");
  }

  const hasDockerOverride = Object.keys(process.env).some((key) =>
    DOCKER_ENVIRONMENT_VARIABLES.has(key.toUpperCase()));
  if (hasDockerOverride) {
    throw new Error("V2 history smoke Docker execution rejected ambient Docker configuration.");
  }

  const systemRoot = process.env.SystemRoot;
  const userProfile = process.env.USERPROFILE;
  if (typeof systemRoot !== "string" ||
      !path.win32.isAbsolute(systemRoot) ||
      typeof userProfile !== "string" ||
      !path.win32.isAbsolute(userProfile)) {
    throw new Error("V2 history smoke Docker execution environment is unavailable.");
  }

  return Object.freeze({
    SystemRoot: systemRoot,
    USERPROFILE: userProfile,
    PATH: path.win32.dirname(APPROVED_DOCKER_EXECUTABLE),
    DOCKER_CONTEXT: APPROVED_DOCKER_CONTEXT,
  });
}

function validateDockerExecutable() {
  let stats;
  try {
    stats = fs.lstatSync(APPROVED_DOCKER_EXECUTABLE);
  } catch {
    throw new Error("Unable to verify the approved Docker executable.");
  }

  let isRegularFile;
  try {
    isRegularFile = stats.isFile() && !stats.isSymbolicLink();
  } catch {
    throw new Error("Unable to verify the approved Docker executable.");
  }
  if (!isRegularFile) {
    throw new Error("The approved Docker executable is unavailable.");
  }
}

function executionFailure(error, operation) {
  const action = operation === "daemon"
    ? "Docker daemon identity check"
    : "V2 history smoke topic command";
  if (error && error.code === "ETIMEDOUT") {
    return new Error(`${action} timed out.`);
  }
  if (error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new Error(`${action} exceeded its output limit.`);
  }
  return new Error(`${action} failed.`);
}

function runDockerCommand(args, environment, operation) {
  return new Promise((resolve, reject) => {
    try {
      childProcess.execFile(
        APPROVED_DOCKER_EXECUTABLE,
        [...args],
        {
          ...EXECUTOR_OPTIONS,
          cwd: REPOSITORY_ROOT,
          env: environment,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(executionFailure(error, operation));
            return;
          }
          if (typeof stdout !== "string" ||
              typeof stderr !== "string" ||
              stderr !== "") {
            reject(new Error(`${operation === "daemon"
              ? "Docker daemon identity check"
              : "V2 history smoke topic command"} returned invalid output.`));
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    } catch (error) {
      reject(executionFailure(error, operation));
    }
  });
}

function hasApprovedDaemonIdOutput(stdout) {
  return stdout === APPROVED_DOCKER_DAEMON_ID ||
    stdout === `${APPROVED_DOCKER_DAEMON_ID}\n` ||
    stdout === `${APPROVED_DOCKER_DAEMON_ID}\r\n`;
}

async function executeHistorySmokeCommand(command, args, options) {
  if (!isExactApprovedArguments(command, args) ||
      !hasExpectedOptions(options)) {
    throw new Error("Unsupported V2 history smoke topic command or options.");
  }

  const environment = validateAmbientEnvironment();
  validateDockerExecutable();

  let composeFileExists;
  try {
    composeFileExists = fs.existsSync(COMPOSE_FILE_PATH);
  } catch {
    throw new Error("Unable to verify the approved V2 Compose file.");
  }
  if (!composeFileExists) {
    throw new Error("The approved V2 Compose file is unavailable.");
  }

  const daemonResult = await runDockerCommand(
    DAEMON_ID_ARGS,
    environment,
    "daemon",
  );
  if (!hasApprovedDaemonIdOutput(daemonResult.stdout)) {
    throw new Error("Docker daemon identity does not match the approved host.");
  }

  // This is a point-in-time identity check; it cannot eliminate a daemon change
  // between the check and the subsequent Compose command.
  return runDockerCommand(
    HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
    environment,
    "topic",
  );
}

module.exports = {
  COMPOSE_FILE_PATH,
  REPOSITORY_ROOT,
  executeHistorySmokeCommand,
};
