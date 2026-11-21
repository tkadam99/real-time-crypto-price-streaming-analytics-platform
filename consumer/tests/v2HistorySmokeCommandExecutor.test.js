const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const { HISTORY_KAFKA_CLUSTER_ID } = require("../v2/historyConsumerConfig");
const {
  HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
} = require("../v2/historySmokeTopicPreflight");
const {
  COMPOSE_FILE_PATH,
  REPOSITORY_ROOT,
  executeHistorySmokeCommand,
} = require("../v2/historySmokeCommandExecutor");

const DOCKER_EXECUTABLE =
  "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const DAEMON_ID = "8f8b080b-cc6a-4a2f-b64c-42b3a4fca236";
const DAEMON_ARGS = [
  "--context",
  "desktop-linux",
  "info",
  "--format",
  "{{.ID}}",
];
const DOCKER_ENVIRONMENT_VARIABLES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
  "DOCKER_CUSTOM_HEADERS",
  "DOCKER_DEFAULT_PLATFORM",
];
const expectedOptions = {
  encoding: "utf8",
  maxBuffer: HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
  shell: false,
  timeout: HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
};
const topicStdout = "verified topic metadata";
const clusterStdout = `Cluster ID: ${HISTORY_KAFKA_CLUSTER_ID}\n`;

function commandKind(args) {
  if (args[0] === "--context") return "daemon";
  return args.includes("/opt/kafka/bin/kafka-cluster.sh") ? "cluster" : "topic";
}

function successfulOutput(args) {
  const kind = commandKind(args);
  return kind === "daemon" ? `${DAEMON_ID}\n` : kind === "cluster" ? clusterStdout : topicStdout;
}

let execFileSpy;
let lstatSyncSpy;
let existsSyncSpy;
let originalDockerEnvironment;

function invoke(
  command = HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
  args = [...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS],
  options = { ...expectedOptions },
) {
  return executeHistorySmokeCommand(command, args, options);
}

function clearDockerEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (DOCKER_ENVIRONMENT_VARIABLES.includes(key.toUpperCase())) {
      delete process.env[key];
    }
  }
}

function regularExecutableStats() {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

beforeEach(() => {
  originalDockerEnvironment = Object.keys(process.env)
    .filter((key) => DOCKER_ENVIRONMENT_VARIABLES.includes(key.toUpperCase()))
    .map((key) => [key, process.env[key]]);
  clearDockerEnvironment();

  execFileSpy = jest.spyOn(childProcess, "execFile").mockImplementation(
    (_command, args, _options, callback) => {
      callback(null, successfulOutput(args), "");
    },
  );
  lstatSyncSpy = jest.spyOn(fs, "lstatSync").mockReturnValue(regularExecutableStats());
  existsSyncSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
  clearDockerEnvironment();
  for (const [key, value] of originalDockerEnvironment) {
    process.env[key] = value;
  }
});

test("uses the approved executable, daemon identity, context, and fixed topic command", async () => {
  await expect(invoke()).resolves.toEqual({
    stdout: topicStdout,
    stderr: "",
    exitCode: 0,
    clusterId: HISTORY_KAFKA_CLUSTER_ID,
  });

  expect(REPOSITORY_ROOT).toBe(path.resolve(__dirname, "..", ".."));
  expect(COMPOSE_FILE_PATH).toBe(path.join(REPOSITORY_ROOT, "docker-compose.v2.yml"));
  expect(lstatSyncSpy).toHaveBeenCalledWith(DOCKER_EXECUTABLE);
  expect(existsSyncSpy).toHaveBeenCalledWith(COMPOSE_FILE_PATH);
  expect(execFileSpy).toHaveBeenCalledTimes(3);

  const [daemonCall, clusterCall, topicCall] = execFileSpy.mock.calls;
  expect(daemonCall[0]).toBe(DOCKER_EXECUTABLE);
  expect(daemonCall[1]).toEqual(DAEMON_ARGS);
  expect(clusterCall[0]).toBe(DOCKER_EXECUTABLE);
  expect(clusterCall[1]).toEqual([
    "compose", "-p", "crypto-v2", "-f", "docker-compose.v2.yml",
    "exec", "-T", "v2-kafka", "/opt/kafka/bin/kafka-cluster.sh",
    "cluster-id", "--bootstrap-server", "v2-kafka:29092",
  ]);
  expect(topicCall[0]).toBe(DOCKER_EXECUTABLE);
  expect(topicCall[1]).toEqual([
    "compose",
    "-p",
    "crypto-v2",
    "-f",
    "docker-compose.v2.yml",
    "exec",
    "-T",
    "v2-kafka",
    "/opt/kafka/bin/kafka-topics.sh",
    "--bootstrap-server",
    "v2-kafka:29092",
    "--describe",
    "--topic",
    "crypto-prices-v2",
  ]);

  for (const [, , options] of execFileSpy.mock.calls) {
    expect(options).toEqual({
      ...expectedOptions,
      cwd: REPOSITORY_ROOT,
      env: {
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: process.env.USERPROFILE,
        PATH: path.win32.dirname(DOCKER_EXECUTABLE),
        DOCKER_CONTEXT: "desktop-linux",
      },
      windowsHide: true,
    });
  }
});

test("verifies the daemon before issuing the topic-description command", async () => {
  const executionOrder = [];
  execFileSpy.mockImplementation((_command, args, _options, callback) => {
    executionOrder.push(commandKind(args));
    callback(null, successfulOutput(args), "");
  });

  await invoke();

  expect(executionOrder).toEqual(["daemon", "cluster", "topic"]);
});

test.each(["", "Cluster ID: another-cluster\n", `${clusterStdout}extra\n`])(
  "rejects invalid cluster identity before querying the topic: %j",
  async (output) => {
    execFileSpy.mockImplementation((_command, args, _options, callback) => {
      callback(null, commandKind(args) === "cluster" ? output : successfulOutput(args), "");
    });
    await expect(invoke()).rejects.toThrow("Kafka cluster identity does not match");
    expect(execFileSpy).toHaveBeenCalledTimes(2);
  },
);

test("sanitizes cluster command failure and never queries the topic", async () => {
  execFileSpy.mockImplementation((_command, args, _options, callback) => {
    if (commandKind(args) === "cluster") {
      callback(new Error("private cluster error"), "", "");
    } else {
      callback(null, successfulOutput(args), "");
    }
  });
  await expect(invoke()).rejects.toThrow("V2 history smoke cluster identity command failed.");
  expect(execFileSpy).toHaveBeenCalledTimes(2);
});

test("rejects a daemon identity mismatch without running the topic command", async () => {
  execFileSpy.mockImplementation((_command, _args, _options, callback) => {
    callback(null, "another-daemon\n", "");
  });

  await expect(invoke()).rejects.toThrow(
    "Docker daemon identity does not match the approved host.",
  );
  expect(execFileSpy).toHaveBeenCalledTimes(1);
});

test.each([
  ["empty output", ""],
  ["trailing data", `${DAEMON_ID}\nprivate-data`],
  ["multiple lines", `${DAEMON_ID}\n${DAEMON_ID}\n`],
  ["malformed identity", "not-a-daemon-id\n"],
])("rejects malformed daemon identity output: %s", async (_label, output) => {
  execFileSpy.mockImplementation((_command, _args, _options, callback) => {
    callback(null, output, "");
  });

  await expect(invoke()).rejects.toThrow(
    "Docker daemon identity does not match the approved host.",
  );
  expect(execFileSpy).toHaveBeenCalledTimes(1);
});

test.each([
  ["DOCKER_HOST", "tcp://unexpected-daemon:2375"],
  ["DOCKER_CONTEXT", "unexpected-context"],
  ["DOCKER_CONFIG", "C:\\private\\docker-config"],
  ["DOCKER_CERT_PATH", "C:\\private\\certs"],
  ["DOCKER_TLS_VERIFY", "1"],
])("rejects ambient %s before invoking Docker", async (name, value) => {
  process.env[name] = value;

  let caught;
  try {
    await invoke();
  } catch (error) {
    caught = error;
  }

  expect(caught.message).toBe(
    "V2 history smoke Docker execution rejected ambient Docker configuration.",
  );
  expect(caught.message).not.toContain(value);
  expect(execFileSpy).not.toHaveBeenCalled();
});

test("rejects an absent executable without resolving one through PATH", async () => {
  lstatSyncSpy.mockImplementation(() => {
    throw new Error("C:\\private\\docker.exe is missing");
  });

  await expect(invoke()).rejects.toThrow(
    "Unable to verify the approved Docker executable.",
  );
  expect(execFileSpy).not.toHaveBeenCalled();
});

test("rejects a non-regular or symbolic-link executable", async () => {
  lstatSyncSpy.mockReturnValue({
    isFile: () => false,
    isSymbolicLink: () => true,
  });

  await expect(invoke()).rejects.toThrow(
    "The approved Docker executable is unavailable.",
  );
  expect(execFileSpy).not.toHaveBeenCalled();
});

test.each([
  [
    "daemon timeout",
    Object.assign(new Error("ETIMEDOUT C:\\private"), { code: "ETIMEDOUT" }),
    "Docker daemon identity check timed out.",
  ],
  [
    "daemon failure",
    Object.assign(new Error("private daemon response"), { code: 1 }),
    "Docker daemon identity check failed.",
  ],
])("sanitizes %s and skips the topic command", async (_label, error, message) => {
  execFileSpy.mockImplementation((_command, _args, _options, callback) => {
    callback(error, "partial private output", "password=secret");
  });

  await expect(invoke()).rejects.toThrow(message);
  expect(execFileSpy).toHaveBeenCalledTimes(1);
});

test.each([
  [
    "topic timeout",
    Object.assign(new Error("ETIMEDOUT C:\\private"), { code: "ETIMEDOUT" }),
    "V2 history smoke topic command timed out.",
  ],
  [
    "topic failure",
    Object.assign(new Error("private topic response"), { code: 1 }),
    "V2 history smoke topic command failed.",
  ],
])("sanitizes %s", async (_label, error, message) => {
  execFileSpy.mockImplementation((_command, args, _options, callback) => {
    const isTopic = commandKind(args) === "topic";
    callback(
      isTopic ? error : null,
      isTopic ? "private output" : successfulOutput(args),
      isTopic ? "password=secret" : "",
    );
  });

  await expect(invoke()).rejects.toThrow(message);
  expect(execFileSpy).toHaveBeenCalledTimes(3);
});

test("rejects nonempty topic stderr without exposing it", async () => {
  execFileSpy.mockImplementation((_command, args, _options, callback) => {
    callback(
      null,
      successfulOutput(args),
      commandKind(args) === "topic" ? "password=secret" : "",
    );
  });

  await expect(invoke()).rejects.toThrow(
    "V2 history smoke topic command returned invalid output.",
  );
  expect(execFileSpy).toHaveBeenCalledTimes(3);
});

test("rejects nonempty daemon stderr without exposing it", async () => {
  execFileSpy.mockImplementation((_command, _args, _options, callback) => {
    callback(null, `${DAEMON_ID}\n`, "password=secret");
  });

  await expect(invoke()).rejects.toThrow(
    "Docker daemon identity check returned invalid output.",
  );
  expect(execFileSpy).toHaveBeenCalledTimes(1);
});

test("rejects modified commands, arguments, or caller options", async () => {
  await expect(invoke("docker.exe")).rejects.toThrow(
    "Unsupported V2 history smoke",
  );
  await expect(invoke(
    HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
    [...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS, "--delete"],
  )).rejects.toThrow("Unsupported V2 history smoke");
  await expect(invoke(
    HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
    [...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS],
    { ...expectedOptions, env: { DOCKER_CONTEXT: "desktop-linux" } },
  )).rejects.toThrow("Unsupported V2 history smoke");
  expect(execFileSpy).not.toHaveBeenCalled();
});

test("importing the module has no filesystem or subprocess side effects", () => {
  jest.isolateModules(() => {
    require("../v2/historySmokeCommandExecutor");
  });

  expect(lstatSyncSpy).not.toHaveBeenCalled();
  expect(execFileSpy).not.toHaveBeenCalled();
});
