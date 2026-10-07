// Every test file runs with outbound network trapped; any attempt throws and is recorded.
process.env.NET_TRAP_LOG ??= new URL("../.test-tmp/net-trap.log", import.meta.url).pathname;
await import("./fixtures/net-trap.mjs");
