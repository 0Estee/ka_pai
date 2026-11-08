#!/usr/bin/env node
// 构建 Godot 端的 Android APK（重构版）。旧版 WebView 壳用 tools/build-apk.ps1，别混用。
//
//   node tools/build-apk-godot.mjs                 出调试包（默认）
//   node tools/build-apk-godot.mjs --release       出正式包（仍用 debug 签名）
//   node tools/build-apk-godot.mjs --fetch-templates  先从官方 tpz 里抠出安卓模板（只下 221MB）
//   node tools/build-apk-godot.mjs --no-dist       不往 dist/ 复制交付物
//
// 依赖（这台机器上的位置写死在下面的常量里，换机器改这几个常量即可）：
//   Godot 4.7.2 自包含安装：exe + editor_data（内含 export_templates 与 debug.keystore）
//   JDK 17、Android SDK（build-tools / platforms / platform-tools）
// 详细说明见 docs/构建APK-Godot端.md

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const GODOT = "E:/kapai-tools/godot/Godot_v4.7.2-stable_win64_console.exe";
const EDITOR_DATA = "E:/kapai-tools/godot/editor_data";
const TPL_VERSION = "4.7.2.stable";
const JDK = "E:/kapai-tools/jdk17/jdk-17.0.21+9";
const SDK = "E:/ka_pai/.toolchain/sdk";
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "").replace(/\/$/, "");
const OUT_APK = "build/android/ka-pai.apk";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const run = (cmd, a, opts = {}) =>
	new Promise((res, rej) =>
		execFile(cmd, a, { maxBuffer: 1 << 24, ...opts }, (err, so, se) =>
			err && !opts.allowFail ? rej(Object.assign(err, { stdout: so, stderr: se })) : res((so || "") + (se || ""))));

// ── 1. 导出模板：从官方 tpz 里按 Range 只抓安卓那几个文件 ──────────────
async function fetchTemplates() {
	const URL_ = "https://github.com/godotengine/godot/releases/download/4.7.2-stable/Godot_v4.7.2-stable_export_templates.tpz";
	const dest = `${EDITOR_DATA}/export_templates/${TPL_VERSION}`;
	mkdirSync(dest, { recursive: true });
	if (existsSync(dest + "/android_debug.apk") && existsSync(dest + "/android_release.apk")) {
		console.log("[templates] 已存在，跳过");
		return;
	}
	console.log("[templates] 读中央目录…");
	const head = await fetch(URL_, { method: "HEAD", redirect: "follow" });
	const total = Number(head.headers.get("content-length"));
	const range = async (s, e) => {
		const r = await fetch(URL_, { headers: { Range: `bytes=${s}-${e}` }, redirect: "follow" });
		return Buffer.from(await r.arrayBuffer());
	};
	const tail = await range(total - 70000, total - 1);
	let eocd = -1;
	for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	if (eocd < 0) throw new Error("找不到 zip 中央目录");
	const cdSize = tail.readUInt32LE(eocd + 12);
	const cdOff = tail.readUInt32LE(eocd + 16);
	const cd = await range(cdOff, cdOff + cdSize - 1);
	const entries = {};
	for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
		const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
		entries[cd.toString("utf8", p + 46, p + 46 + nlen)] = {
			method: cd.readUInt16LE(p + 10), csize: cd.readUInt32LE(p + 20),
			usize: cd.readUInt32LE(p + 24), lho: cd.readUInt32LE(p + 42),
		};
		p += 46 + nlen + elen + clen;
	}
	for (const name of ["templates/android_debug.apk", "templates/android_release.apk", "templates/version.txt"]) {
		const e = entries[name];
		if (!e) throw new Error("tpz 里没有 " + name);
		const hdr = await range(e.lho, e.lho + 29);
		const nlen = hdr.readUInt16LE(26), elen = hdr.readUInt16LE(28);
		const raw = await range(e.lho + 30 + nlen + elen, e.lho + 30 + nlen + elen + e.csize - 1);
		const data = e.method === 0 ? raw : inflateRawSync(raw);
		if (data.length !== e.usize) throw new Error(name + " 解压尺寸不符");
		writeFileSync(dest + "/" + name.replace("templates/", ""), data);
		console.log("[templates] ✓", name, (data.length / 1048576).toFixed(0) + "MB");
	}
}

// ── 2. 环境自检 ───────────────────────────────────────────────
function preflight() {
	const need = [
		[GODOT, "Godot 可执行文件"],
		[JDK + "/bin/java.exe", "JDK（apksigner/d8 要用）"],
		[SDK + "/build-tools/34.0.0/aapt2.exe", "Android build-tools"],
		[SDK + "/platforms/android-34/android.jar", "Android platform 34"],
		[SDK + "/platform-tools/adb.exe", "platform-tools（Godot 会检查 adb）"],
		[EDITOR_DATA + `/export_templates/${TPL_VERSION}/android_debug.apk`, "安卓导出模板（跑 --fetch-templates）"],
	];
	const bad = need.filter(([p]) => !existsSync(p));
	for (const [p, what] of need) console.log((existsSync(p) ? "  ✓ " : "  ✗ ") + what + "  " + p);
	if (bad.length) throw new Error("缺东西，先补齐上面标 ✗ 的：" + bad.map((b) => b[1]).join("、"));
}

// ── 3. 导出 + 校验 + 交付 ─────────────────────────────────────
async function exportApk(release) {
	mkdirSync(ROOT + "/godot/build/android", { recursive: true });
	const env = {
		...process.env,
		JAVA_HOME: JDK,
		ANDROID_HOME: SDK,
		PATH: JDK + "/bin;" + SDK + "/platform-tools;" + (process.env.PATH || ""),
	};
	const mode = release ? "--export-release" : "--export-debug";
	console.log("[export]", mode, OUT_APK);
	const out = await run(GODOT, ["--headless", "--path", "godot", mode, "Android", OUT_APK], { cwd: ROOT, env, timeout: 10 * 60 * 1000 });
	const errs = out.split("\n").filter((l) => /^ERROR:/.test(l) && !/Could not open 'user:\/\/'/.test(l));
	if (errs.length) console.log(errs.join("\n"));
	const apk = ROOT + "/godot/" + OUT_APK;
	if (!existsSync(apk)) throw new Error("没有产出 APK，看上面的 ERROR");
	console.log("[export] ✓", (statSync(apk).size / 1048576).toFixed(1) + "MB");
	return apk;
}

async function verify(apk) {
	const badging = await run(SDK + "/build-tools/34.0.0/aapt.exe", ["dump", "badging", apk]);
	for (const l of badging.split("\n")) if (/^(package:|sdkVersion|targetSdkVersion|native-code)/.test(l)) console.log("[verify]", l);
	const sig = await run(JAVA_BIN(), ["-jar", SDK + "/build-tools/34.0.0/lib/apksigner.jar", "verify", "-v", "--print-certs", apk], { allowFail: true });
	console.log("[verify]", /Verifies/.test(sig) ? "签名 ✓" : "签名 ✗ " + sig.slice(0, 200));
}

const JAVA_BIN = () => JDK + "/bin/java.exe";

// ── main ─────────────────────────────────────────────────────
const version = (readFileSync(ROOT + "/godot/project.godot", "utf8").match(/config\/version="([^"]+)"/) || [, "0.0.0"])[1];
if (has("--fetch-templates")) await fetchTemplates();
preflight();
const apk = await exportApk(has("--release"));
await verify(apk);
if (!has("--no-dist")) {
	mkdirSync(ROOT + "/dist", { recursive: true });
	const to = `${ROOT}/dist/ka-pai-${version}-godot.apk`;
	copyFileSync(apk, to);
	console.log("[dist] ✓", to);
}
