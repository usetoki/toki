const std = @import("std");

// Builds the native addon as zig-out/toki.node. Works on Linux, macOS, and
// Windows, and cross-compiles to any of them with `-Dtarget=` (Zig ships every
// target's libc, so a release can build all platforms from one host).
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const os = target.result.os.tag;

    const mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        // The engine only ever runs on Node's single JS thread: turn thread-safety
        // (mutexes, atomics) into no-ops.
        .single_threaded = true,
    });

    const lib = b.addLibrary(.{
        .name = "toki",
        .root_module = mod,
        .linkage = .dynamic,
    });

    // No @cImport: napi_*/uv_* are hand-declared `extern` and provided by the host
    // Node process. Unix linkers can leave them undefined and resolve at dlopen;
    // a Windows DLL can't, so it links Node's import library instead.
    if (os == .windows) {
        // Pass node.lib with -Dnode-lib=PATH (CI takes it from the node-api-headers
        // cache). Without it the link fails on unresolved napi_*/uv_* symbols.
        if (b.option([]const u8, "node-lib", "Path to node.lib (Windows)")) |path| {
            mod.addObjectFile(.{ .cwd_relative = path });
        }
    } else {
        lib.linker_allow_shlib_undefined = true;
    }

    // Node loads addons by filename, so emit toki.node on every OS (the host lib
    // extension .so/.dylib/.dll is renamed on the way out).
    const install = b.addInstallFileWithDir(lib.getEmittedBin(), .prefix, "toki.node");
    b.getInstallStep().dependOn(&install.step);

    // `zig build test` runs the pure-logic unit suites; the napi/uv-bound modules
    // need a host Node and are covered by the Node test suite instead.
    const test_step = b.step("test", "Run unit tests");
    for ([_][]const u8{
        "src/parser.zig",
        "src/response.zig",
        "src/router.zig",
        "src/mime.zig",
        "src/static.zig",
        "src/ratelimit.zig",
    }) |file| {
        const unit = b.addTest(.{
            .root_module = b.createModule(.{
                .root_source_file = b.path(file),
                .target = target,
                .optimize = optimize,
            }),
        });
        test_step.dependOn(&b.addRunArtifact(unit).step);
    }
}
