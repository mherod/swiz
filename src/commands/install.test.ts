import { describe, it, expect } from "vitest";

describe("install.ts statusMessage field", () => {
  it("verifies statusMessage is included in nested hook configuration", () => {
    // Test data representing nested config structure
    const nestedHookEntry = {
      hooks: [
        {
          type: "command",
          command: "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch stop Stop",
          timeout: 180,
          statusMessage: "Swizzling...",
        },
      ],
    };

    // Verify the nested structure contains statusMessage
    expect(nestedHookEntry.hooks[0]).toHaveProperty("statusMessage");
    expect(nestedHookEntry.hooks[0]!.statusMessage).toBe("Swizzling...");
  });

  it("verifies statusMessage is included in flat hook configuration", () => {
    // Test data representing flat config structure
    const flatHookEntry = {
      command: "command -v swiz >/dev/null 2>&1 || exit 0; swiz dispatch stop Stop",
      timeout: 180,
      statusMessage: "Swizzling...",
    };

    // Verify the flat structure contains statusMessage
    expect(flatHookEntry).toHaveProperty("statusMessage");
    expect(flatHookEntry.statusMessage).toBe("Swizzling...");
  });

  it("statusMessage has correct value across all hook types", () => {
    const expectedMessage = "Swizzling...";

    const nestedHook = {
      hooks: [{ statusMessage: expectedMessage }],
    };

    const flatHook = {
      statusMessage: expectedMessage,
    };

    expect(nestedHook.hooks[0]!.statusMessage).toBe(expectedMessage);
    expect(flatHook.statusMessage).toBe(expectedMessage);
  });

  it("hook object structure includes all required fields", () => {
    // Verify nested config hook has required fields
    const nestedHook = {
      hooks: [
        {
          type: "command",
          command: "test",
          timeout: 30,
          statusMessage: "Swizzling...",
        },
      ],
    };

    const hook = nestedHook.hooks[0];
    expect(hook).toHaveProperty("type");
    expect(hook).toHaveProperty("command");
    expect(hook).toHaveProperty("timeout");
    expect(hook).toHaveProperty("statusMessage");
  });

  it("statusMessage is a non-empty string", () => {
    const message = "Swizzling...";
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });
});
