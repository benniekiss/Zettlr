// Dependency-free generator for small WASI test reactors. Run this file to
// regenerate the fixtures; no Pandoc download or WASM compiler is required.
import { writeFile } from 'node:fs/promises'

const i32 = 0x7f
const i64 = 0x7e
const unsigned = value => {
  const bytes = []
  do {
    const next = value & 127
    value >>>= 7
    bytes.push(next | (value === 0 ? 0 : 128))
  } while (value !== 0)
  return bytes
}
const signed = value => {
  const bytes = []
  while (true) {
    const next = value & 127
    value >>= 7
    const done = (value === 0 && (next & 64) === 0) || (value === -1 && (next & 64) !== 0)
    bytes.push(next | (done ? 0 : 128))
    if (done) return bytes
  }
}
const string = value => [...unsigned(Buffer.byteLength(value)), ...Buffer.from(value)]
const vector = values => [...unsigned(values.length), ...values.flat()]
const section = (id, bytes) => [id, ...unsigned(bytes.length), ...bytes]
const type = (params, results) => [0x60, ...vector(params), ...vector(results)]
const constant = value => [0x41, ...signed(value)]
const wide = value => [0x42, ...signed(value)]
const call = index => [0x10, ...unsigned(index)]
const loadFd = [ ...constant(16), 0x28, 2, 0 ]
const open = (offset, length, flags, rights) => [
  ...constant(3), ...constant(0), ...constant(offset), ...constant(length),
  ...constant(flags), ...wide(rights), ...wide(0), ...constant(0),
  ...constant(16), ...call(0), 0x1a
]
const body = (locals, instructions) => {
  const bytes = [...locals, ...instructions, 0x0b]
  return [...unsigned(bytes.length), ...bytes]
}
const data = (offset, bytes) => [0, ...constant(offset), 0x0b, ...unsigned(bytes.length), ...bytes]

for (const looping of [false, true]) {
  const imports = [
    ['path_open', 0], ['fd_write', 1], ['fd_close', 2]
  ].map(([name, index]) => [...string('wasi_snapshot_preview1'), ...string(name), 0, index])
  const exports = [['memory', 2, 0], ['malloc', 0, 3], ['convert', 0, 4],
    ['query', 0, 5], ['__wasm_call_ctors', 0, 6], ['hs_init_with_rtsopts', 0, 7]]
    .map(([name, kind, index]) => [...string(name), kind, index])
  const bytes = Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([
      type([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]),
      type([i32, i32, i32, i32], [i32]), type([i32], [i32]),
      type([i32, i32], []), type([], [])
    ])),
    ...section(2, vector(imports)),
    ...section(3, vector([[2], [3], [3], [4], [3]])),
    ...section(5, vector([[0, 8]])), // Eight pages for the worker's path buffers.
    ...section(6, vector([[i32, 1, ...constant(1024), 0x0b]])),
    ...section(7, vector(exports)),
    ...section(10, vector([
      // malloc: return the old heap pointer and advance it by the requested size.
      body([1, 1, i32], [0x23, 0, 0x22, 1, 0x20, 0, 0x6a, 0x24, 0, 0x20, 1]),
      // The looping converter deliberately leaves a native input descriptor open.
      body([0], looping ? [...open(48, 8, 0, 2), 0x03, 0x40, 0x0c, 0, 0x0b] : []),
      // query: write a plausible version to the reactor's stdout file via WASI.
      body([0], [...open(0, 6, 9, 64), ...loadFd, ...constant(20),
        ...constant(1), ...constant(28), ...call(1), 0x1a, ...loadFd, ...call(2), 0x1a]),
      body([0], []), body([0], [])
    ])),
    ...section(11, vector([
      data(0, Buffer.from('stdout')), data(20, [32, 0, 0, 0, 8, 0, 0, 0]),
      data(32, Buffer.from('"3.12.0"')), data(48, Buffer.from('input.md'))
    ]))
  ])
  await WebAssembly.compile(bytes)
  await writeFile(new URL(looping ? './looping-reactor.wasm' : './reactor.wasm', import.meta.url), bytes)
}
