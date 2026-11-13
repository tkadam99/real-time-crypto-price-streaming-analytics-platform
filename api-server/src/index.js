const app = require("./app");
const { connectDB, closeDB } = require("./db");
const config = require("./config");

const SHUTDOWN_GRACE_MS = 10_000;
const FORCED_CLEANUP_MS = 2_000;

function createLifecycle({
    application = app,
    connect = connectDB,
    disconnect = closeDB,
    port = config.port,
    processObject = process,
    graceMs = SHUTDOWN_GRACE_MS,
    forcedCleanupMs = FORCED_CLEANUP_MS,
} = {}) {
    let server;
    let startup;
    let shutdownPromise;
    let startupFailed = false;

    function listen() {
        return new Promise((resolve, reject) => {
            server = application.listen(port);
            const onError = (error) => {
                server.removeListener("listening", onListening);
                reject(error);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                console.log(`API server running on http://localhost:${port}`);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
        });
    }

    function closeHttp() {
        if (!server || !server.listening) return Promise.resolve();
        return new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }

    function forceCloseHttp() {
        if (!server) return;
        try {
            server.closeAllConnections();
        } catch (error) {
            console.error("Failed to force HTTP connections closed:", error.message);
        }
    }

    function shutdown(reason) {
        if (shutdownPromise) return shutdownPromise;

        console.log(`API shutdown started: ${reason}`);
        shutdownPromise = (async () => {
            let failed = false;
            let graceTimer;
            const deadline = new Promise((resolve) => {
                graceTimer = setTimeout(() => resolve("timeout"), graceMs);
            });
            const httpShutdown = (async () => {
                if (startup) await startup;
                console.log("Closing API HTTP server");
                await closeHttp();
                return "closed";
            })();

            try {
                const result = await Promise.race([httpShutdown, deadline]);
                if (result === "timeout") {
                    failed = true;
                    console.error("API shutdown timed out; forcing HTTP connections closed");
                    forceCloseHttp();
                }
            } catch (error) {
                failed = true;
                console.error("Failed to close API HTTP server:", error.message);
                forceCloseHttp();
            } finally {
                clearTimeout(graceTimer);
            }

            console.log("Closing API MongoDB connection");
            let cleanupTimer;
            const cleanupDeadline = new Promise((resolve) => {
                cleanupTimer = setTimeout(() => resolve("timeout"), forcedCleanupMs);
            });
            try {
                const result = await Promise.race([
                    Promise.resolve().then(() => disconnect()).then(() => "closed"),
                    cleanupDeadline,
                ]);
                if (result === "timeout") {
                    failed = true;
                    console.error("MongoDB shutdown timed out");
                }
            } catch (error) {
                failed = true;
                console.error("Failed to close API MongoDB connection:", error.message);
            } finally {
                clearTimeout(cleanupTimer);
            }

            const exitCode = failed || startupFailed ? 1 : 0;
            console.log(`API shutdown complete with exit code ${exitCode}`);
            processObject.exit(exitCode);
        })();
        return shutdownPromise;
    }

    async function start() {
        processObject.on("SIGINT", () => { void shutdown("SIGINT"); });
        processObject.on("SIGTERM", () => { void shutdown("SIGTERM"); });

        startup = Promise.resolve().then(async () => {
            try {
                if (shutdownPromise) return;
                await connect();
                if (!shutdownPromise) await listen();
            } catch (error) {
                startupFailed = true;
                console.error("Failed to start API server:", error.message);
            }
        });
        await startup;
        if (startupFailed) await shutdown("startup failure");
    }

    return { start };
}

if (require.main === module) {
    void createLifecycle().start();
}

module.exports = { createLifecycle };
