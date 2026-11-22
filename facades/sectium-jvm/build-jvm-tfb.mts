/**
 * Builds the Sectium-JVM TechEmpower compute kernel facade:
 *   1. Emits a real 0xCAFEBABE JVM class (`TfbBench.class`) running:
 *        - recursive `fib(25)` (= 75025)
 *        - 100,000-iteration integer accumulator loop `loopSum(100000)` (= 12742320)
 *      printing both results via `System.out.println(int)`.
 *   2. Compiles Tier-2 AOT `tfb-jvm-aot.exe` via:
 *        `sectium-jvm.exe --emit-c TfbBench.class TfbBench.c`
 *        `zig.cmd cc -target x86_64-windows-gnu -std=c11 -O3 -s TfbBench.c -o tfb-jvm-aot.exe`
 *   3. Verifies both Tier-0 interpreter and Tier-2 AOT native binary produce
 *      exact identical stdout (`75025\n12742320`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAIN_REPO_ROOT = 'E:\\awesome-os';
const WORKTREE_ROOT = path.resolve(THIS_DIR, '..', '..', '..');

const CLASS_EMITTER_CANDIDATES = [
  path.join(WORKTREE_ROOT, 'sections', 'b8g-runtime', 'class-emitter.mts'),
  path.join(MAIN_REPO_ROOT, 'sections', 'b8g-runtime', 'class-emitter.mts'),
];
const CLASS_EMITTER_PATH = CLASS_EMITTER_CANDIDATES.find((p) => fs.existsSync(p));
if (!CLASS_EMITTER_PATH) {
  throw new Error(`Could not locate class-emitter.mts in: ${CLASS_EMITTER_CANDIDATES.join(', ')}`);
}

const emitter = (await import(pathToFileURL(CLASS_EMITTER_PATH).href)) as typeof import('E:/awesome-os/sections/b8g-runtime/class-emitter.mts');
const { BytecodeBuilder, JVM_OPCODES, emitMinimalClassFile } = emitter;

const SECTIUM_JVM_BIN = path.join(MAIN_REPO_ROOT, 'sections', 'b8g-jvm', 'dist', 'sectium-jvm.exe');
const ZIG_CMD = path.join(MAIN_REPO_ROOT, 'bin', 'zig.cmd');

const CLASS_PATH = path.join(THIS_DIR, 'TfbBench.class');
const C_PATH = path.join(THIS_DIR, 'TfbBench.c');
const AOT_EXE_PATH = path.join(THIS_DIR, 'tfb-jvm-aot.exe');

function emitTfbBenchClass(): Uint8Array {
  return emitMinimalClassFile({
    className: 'TfbBench',
    methods: (cp) => {
      const fibRef = cp.addMethodref('TfbBench', 'fib', '(I)I');
      const loopSumRef = cp.addMethodref('TfbBench', 'loopSum', '(I)I');
      const systemOutRef = cp.addFieldref('java/lang/System', 'out', 'Ljava/io/PrintStream;');
      const printlnIntRef = cp.addMethodref('java/io/PrintStream', 'println', '(I)V');

      // public static int fib(int n)
      const fibCode = new BytecodeBuilder()
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_1)
        .branch(JVM_OPCODES.if_icmpgt, 'recurse')
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.ireturn)
        .mark('recurse')
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_1)
        .op(JVM_OPCODES.isub)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .op(JVM_OPCODES.iload_0)
        .op(JVM_OPCODES.iconst_2)
        .op(JVM_OPCODES.isub)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .op(JVM_OPCODES.iadd)
        .op(JVM_OPCODES.ireturn)
        .build();

      // public static int loopSum(int limit):
      //   int sum = 0;  (local 1)
      //   int i = 0;    (local 2)
      //   while (i < limit) { sum += (i & 255); i++; }
      //   return sum;
      const loopCode = new BytecodeBuilder()
        .op(JVM_OPCODES.iconst_0)
        .op(JVM_OPCODES.istore_1)
        .op(JVM_OPCODES.iconst_0)
        .op(JVM_OPCODES.istore_2)
        .mark('loop_head')
        .op(JVM_OPCODES.iload_2)
        .op(JVM_OPCODES.iload_0)
        .branch(JVM_OPCODES.if_icmpge, 'loop_done')
        .op(JVM_OPCODES.iload_1)
        .op(JVM_OPCODES.iload_2)
        .pushInt(255, cp)
        .op(JVM_OPCODES.iand)
        .op(JVM_OPCODES.iadd)
        .op(JVM_OPCODES.istore_1)
        .opIinc(2, 1)
        .branch(JVM_OPCODES.goto, 'loop_head')
        .mark('loop_done')
        .op(JVM_OPCODES.iload_1)
        .op(JVM_OPCODES.ireturn)
        .build();

      // public static void main(String[] args):
      //   System.out.println(fib(25));
      //   System.out.println(loopSum(100000));
      const mainCode = new BytecodeBuilder()
        .opU2(JVM_OPCODES.getstatic, systemOutRef)
        .pushInt(25, cp)
        .opU2(JVM_OPCODES.invokestatic, fibRef)
        .opU2(JVM_OPCODES.invokevirtual, printlnIntRef)
        .opU2(JVM_OPCODES.getstatic, systemOutRef)
        .pushInt(100000, cp)
        .opU2(JVM_OPCODES.invokestatic, loopSumRef)
        .opU2(JVM_OPCODES.invokevirtual, printlnIntRef)
        .op(JVM_OPCODES.return)
        .build();

      return [
        {
          name: 'fib',
          descriptor: '(I)I',
          maxStack: 4,
          maxLocals: 1,
          code: fibCode,
        },
        {
          name: 'loopSum',
          descriptor: '(I)I',
          maxStack: 4,
          maxLocals: 3,
          code: loopCode,
        },
        {
          name: 'main',
          descriptor: '([Ljava/lang/String;)V',
          maxStack: 3,
          maxLocals: 1,
          code: mainCode,
        },
      ];
    },
  });
}

// 1. Emit TfbBench.class (0xCAFEBABE)
const classBytes = emitTfbBenchClass();
assert.equal(classBytes[0], 0xca);
assert.equal(classBytes[1], 0xfe);
assert.equal(classBytes[2], 0xba);
assert.equal(classBytes[3], 0xbe);
fs.writeFileSync(CLASS_PATH, classBytes);

// 2. Emit C11 via sectium-jvm.exe --emit-c
const emitRes = spawnSync(SECTIUM_JVM_BIN, ['--emit-c', CLASS_PATH, C_PATH], {
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
});
assert.equal(emitRes.status, 0, `sectium-jvm --emit-c failed: ${emitRes.stderr || emitRes.stdout}`);

// 3. Compile Tier-2 AOT native binary via E:\awesome-os\bin\zig.cmd cc
const comspec = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
const ccRes = spawnSync(
  comspec,
  ['/d', '/s', '/c', ZIG_CMD, 'cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O3', '-s', C_PATH, '-o', AOT_EXE_PATH],
  {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  },
);
assert.equal(ccRes.status, 0, `zig cc failed: ${ccRes.stderr || ccRes.stdout}`);

// 4. Verify Tier-0 interpreter and Tier-2 AOT native binary
const EXPECTED = '75025\n12742320';

const t0Start = performance.now();
const tier0 = spawnSync(SECTIUM_JVM_BIN, ['--run', CLASS_PATH], {
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
});
const tier0Ms = performance.now() - t0Start;
assert.equal(tier0.status, 0, `Tier-0 failed: ${tier0.stderr}`);
const tier0Out = tier0.stdout.replace(/\r\n/g, '\n').trim();
assert.equal(tier0Out, EXPECTED, `Tier-0 output mismatch: ${tier0Out}`);

const t2Start = performance.now();
const tier2 = spawnSync(AOT_EXE_PATH, [], {
  encoding: 'utf8',
  shell: false,
  windowsHide: true,
});
const tier2Ms = performance.now() - t2Start;
assert.equal(tier2.status, 0, `Tier-2 AOT failed: ${tier2.stderr}`);
const tier2Out = tier2.stdout.replace(/\r\n/g, '\n').trim();
assert.equal(tier2Out, EXPECTED, `Tier-2 AOT output mismatch: ${tier2Out}`);

const classSize = fs.statSync(CLASS_PATH).size;
const aotSize = fs.statSync(AOT_EXE_PATH).size;

console.log(`TfbBench.class: ${classSize} bytes (0xCAFEBABE)`);
console.log(`tfb-jvm-aot.exe: ${aotSize} bytes`);
console.log(`Tier-0 output: ${tier0Out.replace('\n', ', ')} (${tier0Ms.toFixed(2)} ms wall)`);
console.log(`Tier-2 output: ${tier2Out.replace('\n', ', ')} (${tier2Ms.toFixed(2)} ms wall)`);
