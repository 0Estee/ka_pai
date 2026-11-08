#!/usr/bin/env node
// 统一的 Godot 启动器：Godot 与临时目录都在工程内（.toolchain/、.tmp/），C 盘不留东西。
//
//   node tools/godot.mjs --headless --path godot --script res://tests/smoke.gd
//   node tools/godot.mjs --path godot --resolution 720x1280 --script res://tests/ui_shots.gd -- --out E:/ka_pai/shots
//
// 参数原样转给 Godot；工作目录固定为仓库根（--path godot 才对得上）。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const GODOT = ROOT + "/.toolchain/godot/Godot_v4.7.2-stable_win64_console.exe";
const TMP = ROOT + "/.tmp";

if (!existsSync(GODOT)) {
	console.error("找不到 Godot：" + GODOT);
	console.error("见 docs/构建APK-Godot端.md §1（工具链自带在 .toolchain/，换机器要搬过来）");
	process.exit(1);
}
mkdirSync(TMP, { recursive: true });

const child = spawn(GODOT, process.argv.slice(2), {
	stdio: "inherit",
	cwd: ROOT,
	env: { ...process.env, TEMP: TMP, TMP: TMP, TMPDIR: TMP },
});
child.on("exit", (code, sig) => process.exit(code === null ? (sig ? 1 : 0) : code));
