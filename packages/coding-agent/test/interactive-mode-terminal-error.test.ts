import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode, isDeadTerminalError } from "../src/modes/interactive/interactive-mode.ts";

describe("isDeadTerminalError", () => {
	test("identifies dead terminal error codes", () => {
		const eioError = Object.assign(new Error("input/output error"), { code: "EIO" });
		const epipeError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		const enotconnError = Object.assign(new Error("socket is not connected"), { code: "ENOTCONN" });

		expect(isDeadTerminalError(eioError)).toBe(true);
		expect(isDeadTerminalError(epipeError)).toBe(true);
		expect(isDeadTerminalError(enotconnError)).toBe(true);
	});

	test("identifies read EIO and write EPIPE messages", () => {
		expect(isDeadTerminalError(new Error("read EIO"))).toBe(true);
		expect(isDeadTerminalError(new Error("write EPIPE"))).toBe(true);
		expect(isDeadTerminalError(new Error("write EIO"))).toBe(true);
	});

	test("returns false for non-dead-terminal errors", () => {
		expect(isDeadTerminalError(new Error("file not found"))).toBe(false);
		expect(isDeadTerminalError(Object.assign(new Error("file not found"), { code: "ENOENT" }))).toBe(false);
		expect(isDeadTerminalError(null)).toBe(false);
		expect(isDeadTerminalError(undefined)).toBe(false);
		expect(isDeadTerminalError("EIO")).toBe(false);
	});
});

type InteractiveModeWithInternals = {
	registerSignalHandlers(): void;
	unregisterSignalHandlers(): void;
	emergencyTerminalExit(): never;
	uncaughtCrash(error: Error): never;
	signalCleanupHandlers: (() => void)[];
	isShuttingDown: boolean;
};

describe("InteractiveMode terminal error handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("registers error listener on stdin, stdout, and stderr", () => {
		const fakeStdin = new EventEmitter();
		const fakeStdout = new EventEmitter();
		const fakeStderr = new EventEmitter();

		const stdinOnSpy = vi.spyOn(fakeStdin, "on");
		const stdoutOnSpy = vi.spyOn(fakeStdout, "on");
		const stderrOnSpy = vi.spyOn(fakeStderr, "on");

		const emergencyTerminalExit = vi.fn();
		const context: InteractiveModeWithInternals = {
			isShuttingDown: false,
			signalCleanupHandlers: [],
			emergencyTerminalExit: emergencyTerminalExit as unknown as () => never,
			unregisterSignalHandlers() {
				(InteractiveMode.prototype as unknown as InteractiveModeWithInternals).unregisterSignalHandlers.call(this);
			},
			registerSignalHandlers() {
				(InteractiveMode.prototype as unknown as InteractiveModeWithInternals).registerSignalHandlers.call(this);
			},
			uncaughtCrash(error: Error) {
				return (InteractiveMode.prototype as unknown as InteractiveModeWithInternals).uncaughtCrash.call(
					this,
					error,
				);
			},
		};

		const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
		const stdoutDesc = Object.getOwnPropertyDescriptor(process, "stdout");
		const stderrDesc = Object.getOwnPropertyDescriptor(process, "stderr");

		Object.defineProperty(process, "stdin", { configurable: true, value: fakeStdin });
		Object.defineProperty(process, "stdout", { configurable: true, value: fakeStdout });
		Object.defineProperty(process, "stderr", { configurable: true, value: fakeStderr });

		try {
			context.registerSignalHandlers();

			expect(stdinOnSpy).toHaveBeenCalledWith("error", expect.any(Function));
			expect(stdoutOnSpy).toHaveBeenCalledWith("error", expect.any(Function));
			expect(stderrOnSpy).toHaveBeenCalledWith("error", expect.any(Function));

			// Trigger EIO on stdin
			const eio = Object.assign(new Error("read EIO"), { code: "EIO" });
			fakeStdin.emit("error", eio);
			expect(emergencyTerminalExit).toHaveBeenCalledTimes(1);

			// Unregister signal handlers cleans up
			context.unregisterSignalHandlers();
			expect(fakeStdin.listenerCount("error")).toBe(0);
			expect(fakeStdout.listenerCount("error")).toBe(0);
			expect(fakeStderr.listenerCount("error")).toBe(0);
		} finally {
			if (stdinDesc) Object.defineProperty(process, "stdin", stdinDesc);
			if (stdoutDesc) Object.defineProperty(process, "stdout", stdoutDesc);
			if (stderrDesc) Object.defineProperty(process, "stderr", stderrDesc);
		}
	});

	test("uncaughtCrash delegates dead terminal errors directly to emergencyTerminalExit", () => {
		const emergencyTerminalExit = vi.fn().mockImplementation(() => {
			throw new Error("emergency-exit");
		});
		const context: Partial<InteractiveModeWithInternals> = {
			isShuttingDown: false,
			emergencyTerminalExit: emergencyTerminalExit as unknown as () => never,
		};

		const deadError = Object.assign(new Error("read EIO"), { code: "EIO" });

		expect(() =>
			(InteractiveMode.prototype as unknown as InteractiveModeWithInternals).uncaughtCrash.call(
				context as InteractiveModeWithInternals,
				deadError,
			),
		).toThrow("emergency-exit");

		expect(emergencyTerminalExit).toHaveBeenCalledTimes(1);
	});
});
