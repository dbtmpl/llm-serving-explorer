export interface VirtualFsStats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

type FsNode =
  | { kind: "dir"; ino: number; mtimeMs: number }
  | { kind: "file"; ino: number; mtimeMs: number; data: Uint8Array };

interface OpenFd {
  path: string;
  flags: number;
  pos: number;
}

const S_IFDIR = 0o040755;
const S_IFREG = 0o100644;

const FS_CONSTANTS = {
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_EXCL: 128,
  O_TRUNC: 512,
  O_APPEND: 1024,
  O_DIRECTORY: 65536
} as const;

function makeFsError(code: string, message: string): Error & { code: string } {
  const err = new Error(`${code}: ${message}`) as Error & { code: string };
  err.code = code;
  return err;
}

export function normalizePosixPath(input: string, cwd = "/"): string {
  const combined = input.startsWith("/") ? input : `${cwd === "/" ? "" : cwd}/${input}`;
  const parts = combined.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return `/${stack.join("/")}`;
}

function parentPath(p: string): string {
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function baseName(p: string): string {
  if (p === "/") return "";
  const idx = p.lastIndexOf("/");
  return p.slice(idx + 1);
}

export interface VirtualFsEnvironment {
  fs: Record<string, unknown>;
  process: Record<string, unknown>;
  path: { resolve: (...segments: string[]) => string };
  reset(initialFiles?: Record<string, string | Uint8Array>): void;
  writeVirtualFile(filePath: string, content: string | Uint8Array): void;
  mkdirp(dirPath: string): void;
  readVirtualFileText(filePath: string): string;
  readVirtualFileBytes(filePath: string): Uint8Array;
  getStdout(): string;
  getStderr(): string;
  clearStdio(): void;
}

/**
 * Creates an in-memory POSIX-like filesystem, process, and path shim compatible with Go's
 * `GOOS=js GOARCH=wasm` `wasm_exec.js` runtime (`syscall/fs_js.go`).
 */
export function createVirtualFsEnvironment(): VirtualFsEnvironment {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const nodes = new Map<string, FsNode>();
  const fds = new Map<number, OpenFd>();
  let nextIno = 1;
  let nextFd = 3;
  let cwd = "/";
  let stdoutChunks: Uint8Array[] = [];
  let stderrChunks: Uint8Array[] = [];

  const initBaseDirs = () => {
    nodes.clear();
    fds.clear();
    nextIno = 1;
    nextFd = 3;
    cwd = "/";
    const now = Date.now();
    nodes.set("/", { kind: "dir", ino: nextIno++, mtimeMs: now });
    nodes.set("/tmp", { kind: "dir", ino: nextIno++, mtimeMs: now });
    nodes.set("/sim", { kind: "dir", ino: nextIno++, mtimeMs: now });
  };

  initBaseDirs();

  const mkdirp = (dirPath: string): void => {
    const norm = normalizePosixPath(dirPath, cwd);
    if (norm === "/") return;
    const parts = norm.slice(1).split("/");
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      const existing = nodes.get(cur);
      if (!existing) {
        nodes.set(cur, { kind: "dir", ino: nextIno++, mtimeMs: Date.now() });
      } else if (existing.kind !== "dir") {
        throw makeFsError("ENOTDIR", `${cur} is not a directory`);
      }
    }
  };

  const writeVirtualFile = (filePath: string, content: string | Uint8Array): void => {
    const norm = normalizePosixPath(filePath, cwd);
    mkdirp(parentPath(norm));
    const bytes = typeof content === "string" ? encoder.encode(content) : new Uint8Array(content);
    nodes.set(norm, { kind: "file", ino: nextIno++, mtimeMs: Date.now(), data: bytes });
  };

  const readVirtualFileBytes = (filePath: string): Uint8Array => {
    const norm = normalizePosixPath(filePath, cwd);
    const node = nodes.get(norm);
    if (!node) {
      throw makeFsError("ENOENT", `no such file: ${norm}`);
    }
    if (node.kind !== "file") {
      throw makeFsError("EISDIR", `illegal operation on directory: ${norm}`);
    }
    return new Uint8Array(node.data);
  };

  const readVirtualFileText = (filePath: string): string => {
    return decoder.decode(readVirtualFileBytes(filePath));
  };

  const makeStats = (node: FsNode): VirtualFsStats => {
    const isDir = node.kind === "dir";
    const size = isDir ? 0 : node.data.byteLength;
    return {
      dev: 0,
      ino: node.ino,
      mode: isDir ? S_IFDIR : S_IFREG,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: node.mtimeMs,
      mtimeMs: node.mtimeMs,
      ctimeMs: node.mtimeMs,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isSymbolicLink: () => false
    };
  };

  const concatChunks = (chunks: Uint8Array[]): string => {
    if (chunks.length === 0) return "";
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return decoder.decode(merged);
  };

  const fsShim: Record<string, unknown> = {
    constants: FS_CONSTANTS,

    writeSync(fd: number, buf: Uint8Array): number {
      const copy = new Uint8Array(buf);
      if (fd === 1) {
        stdoutChunks.push(copy);
        return copy.byteLength;
      }
      if (fd === 2) {
        stderrChunks.push(copy);
        return copy.byteLength;
      }
      const handle = fds.get(fd);
      if (!handle) {
        throw makeFsError("EBADF", `bad file descriptor ${fd}`);
      }
      const node = nodes.get(handle.path);
      if (!node || node.kind !== "file") {
        throw makeFsError("EBADF", `fd ${fd} is not a writable file`);
      }
      const writeAt = (handle.flags & FS_CONSTANTS.O_APPEND) !== 0 ? node.data.byteLength : handle.pos;
      const needed = writeAt + copy.byteLength;
      if (needed > node.data.byteLength) {
        const grown = new Uint8Array(needed);
        grown.set(node.data, 0);
        node.data = grown;
      }
      node.data.set(copy, writeAt);
      node.mtimeMs = Date.now();
      handle.pos = writeAt + copy.byteLength;
      return copy.byteLength;
    },

    write(
      fd: number,
      buf: Uint8Array,
      offset: number,
      length: number,
      position: number | null | undefined,
      callback: (err: Error | null, written?: number) => void
    ): void {
      const slice = new Uint8Array(buf.buffer, buf.byteOffset + offset, length);
      if (fd === 1 || fd === 2) {
        const written = (fsShim.writeSync as (f: number, b: Uint8Array) => number)(fd, slice);
        callback(null, written);
        return;
      }
      const handle = fds.get(fd);
      if (!handle) {
        callback(makeFsError("EBADF", `bad file descriptor ${fd}`));
        return;
      }
      const node = nodes.get(handle.path);
      if (!node || node.kind !== "file") {
        callback(makeFsError("EBADF", `fd ${fd} is not a file`));
        return;
      }
      const writeAt =
        position !== null && position !== undefined
          ? position
          : (handle.flags & FS_CONSTANTS.O_APPEND) !== 0
            ? node.data.byteLength
            : handle.pos;
      const needed = writeAt + slice.byteLength;
      if (needed > node.data.byteLength) {
        const grown = new Uint8Array(needed);
        grown.set(node.data, 0);
        node.data = grown;
      }
      node.data.set(slice, writeAt);
      node.mtimeMs = Date.now();
      if (position === null || position === undefined) {
        handle.pos = writeAt + slice.byteLength;
      }
      callback(null, slice.byteLength);
    },

    read(
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null | undefined,
      callback: (err: Error | null, bytesRead?: number) => void
    ): void {
      const handle = fds.get(fd);
      if (!handle) {
        callback(makeFsError("EBADF", `bad file descriptor ${fd}`));
        return;
      }
      const node = nodes.get(handle.path);
      if (!node) {
        callback(makeFsError("ENOENT", `missing file ${handle.path}`));
        return;
      }
      if (node.kind === "dir") {
        callback(makeFsError("EISDIR", `${handle.path} is a directory`));
        return;
      }
      const readAt = position !== null && position !== undefined ? position : handle.pos;
      if (readAt >= node.data.byteLength || length <= 0) {
        callback(null, 0);
        return;
      }
      const available = node.data.byteLength - readAt;
      const count = Math.min(length, available);
      buffer.set(node.data.subarray(readAt, readAt + count), offset);
      if (position === null || position === undefined) {
        handle.pos = readAt + count;
      }
      callback(null, count);
    },

    open(
      filePath: string,
      flags: number,
      _mode: number,
      callback: (err: Error | null, fd?: number) => void
    ): void {
      const norm = normalizePosixPath(filePath, cwd);
      const existing = nodes.get(norm);
      const isCreate = (flags & FS_CONSTANTS.O_CREAT) !== 0;
      const isExcl = (flags & FS_CONSTANTS.O_EXCL) !== 0;
      const isTrunc = (flags & FS_CONSTANTS.O_TRUNC) !== 0;
      const isDirFlag = (flags & FS_CONSTANTS.O_DIRECTORY) !== 0;
      const isWrite =
        (flags & FS_CONSTANTS.O_WRONLY) !== 0 || (flags & FS_CONSTANTS.O_RDWR) !== 0;

      if (!existing) {
        if (!isCreate) {
          callback(makeFsError("ENOENT", `no such file or directory: ${norm}`));
          return;
        }
        const parent = nodes.get(parentPath(norm));
        if (!parent || parent.kind !== "dir") {
          callback(makeFsError("ENOENT", `parent directory missing for ${norm}`));
          return;
        }
        nodes.set(norm, {
          kind: "file",
          ino: nextIno++,
          mtimeMs: Date.now(),
          data: new Uint8Array(0)
        });
      } else {
        if (isCreate && isExcl) {
          callback(makeFsError("EEXIST", `file already exists: ${norm}`));
          return;
        }
        if (existing.kind === "dir" && isWrite) {
          callback(makeFsError("EISDIR", `illegal operation on a directory: ${norm}`));
          return;
        }
        if (existing.kind !== "dir" && isDirFlag) {
          callback(makeFsError("ENOTDIR", `not a directory: ${norm}`));
          return;
        }
        if (existing.kind === "file" && isTrunc && isWrite) {
          existing.data = new Uint8Array(0);
          existing.mtimeMs = Date.now();
        }
      }

      const fd = nextFd++;
      fds.set(fd, { path: norm, flags, pos: 0 });
      callback(null, fd);
    },

    close(fd: number, callback: (err: Error | null) => void): void {
      if (!fds.has(fd)) {
        callback(makeFsError("EBADF", `bad file descriptor ${fd}`));
        return;
      }
      fds.delete(fd);
      callback(null);
    },

    stat(filePath: string, callback: (err: Error | null, stats?: VirtualFsStats) => void): void {
      const norm = normalizePosixPath(filePath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", `no such file or directory: ${norm}`));
        return;
      }
      callback(null, makeStats(node));
    },

    lstat(filePath: string, callback: (err: Error | null, stats?: VirtualFsStats) => void): void {
      (fsShim.stat as (p: string, cb: (err: Error | null, stats?: VirtualFsStats) => void) => void)(
        filePath,
        callback
      );
    },

    fstat(fd: number, callback: (err: Error | null, stats?: VirtualFsStats) => void): void {
      if (fd === 0 || fd === 1 || fd === 2) {
        callback(null, {
          dev: 0,
          ino: fd,
          mode: 0o020666,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 0,
          blksize: 4096,
          blocks: 0,
          atimeMs: 0,
          mtimeMs: 0,
          ctimeMs: 0,
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => false
        });
        return;
      }
      const handle = fds.get(fd);
      if (!handle) {
        callback(makeFsError("EBADF", `bad file descriptor ${fd}`));
        return;
      }
      const node = nodes.get(handle.path);
      if (!node) {
        callback(makeFsError("ENOENT", `missing path ${handle.path}`));
        return;
      }
      callback(null, makeStats(node));
    },

    readdir(dirPath: string, callback: (err: Error | null, entries?: string[]) => void): void {
      const norm = normalizePosixPath(dirPath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", `no such directory: ${norm}`));
        return;
      }
      if (node.kind !== "dir") {
        callback(makeFsError("ENOTDIR", `not a directory: ${norm}`));
        return;
      }
      const prefix = norm === "/" ? "/" : `${norm}/`;
      const entries: string[] = [];
      for (const key of nodes.keys()) {
        if (key === norm || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.push(rest);
        }
      }
      entries.sort();
      callback(null, entries);
    },

    mkdir(dirPath: string, _perm: number, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(dirPath, cwd);
      if (nodes.has(norm)) {
        callback(makeFsError("EEXIST", `file already exists: ${norm}`));
        return;
      }
      const parent = nodes.get(parentPath(norm));
      if (!parent) {
        callback(makeFsError("ENOENT", `parent directory missing for ${norm}`));
        return;
      }
      if (parent.kind !== "dir") {
        callback(makeFsError("ENOTDIR", `parent is not a directory: ${norm}`));
        return;
      }
      nodes.set(norm, { kind: "dir", ino: nextIno++, mtimeMs: Date.now() });
      callback(null);
    },

    rmdir(dirPath: string, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(dirPath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", `no such directory: ${norm}`));
        return;
      }
      if (node.kind !== "dir") {
        callback(makeFsError("ENOTDIR", `not a directory: ${norm}`));
        return;
      }
      const prefix = norm === "/" ? "/" : `${norm}/`;
      for (const key of nodes.keys()) {
        if (key !== norm && key.startsWith(prefix)) {
          callback(makeFsError("ENOTEMPTY", `directory not empty: ${norm}`));
          return;
        }
      }
      nodes.delete(norm);
      callback(null);
    },

    unlink(filePath: string, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(filePath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", `no such file: ${norm}`));
        return;
      }
      if (node.kind === "dir") {
        callback(makeFsError("EISDIR", `cannot unlink directory: ${norm}`));
        return;
      }
      nodes.delete(norm);
      callback(null);
    },

    rename(fromPath: string, toPath: string, callback: (err: Error | null) => void): void {
      const from = normalizePosixPath(fromPath, cwd);
      const to = normalizePosixPath(toPath, cwd);
      const node = nodes.get(from);
      if (!node) {
        callback(makeFsError("ENOENT", `no such file or directory: ${from}`));
        return;
      }
      const toParent = nodes.get(parentPath(to));
      if (!toParent || toParent.kind !== "dir") {
        callback(makeFsError("ENOENT", `destination parent missing: ${to}`));
        return;
      }
      nodes.delete(from);
      nodes.set(to, node);
      if (node.kind === "dir") {
        const fromPrefix = `${from}/`;
        const toPrefix = `${to}/`;
        const toMove: Array<[string, FsNode]> = [];
        for (const [k, v] of nodes.entries()) {
          if (k.startsWith(fromPrefix)) {
            toMove.push([k, v]);
          }
        }
        for (const [k, v] of toMove) {
          nodes.delete(k);
          nodes.set(`${toPrefix}${k.slice(fromPrefix.length)}`, v);
        }
      }
      callback(null);
    },

    truncate(filePath: string, length: number, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(filePath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", `no such file: ${norm}`));
        return;
      }
      if (node.kind !== "file") {
        callback(makeFsError("EISDIR", `not a file: ${norm}`));
        return;
      }
      const next = new Uint8Array(Math.max(0, length));
      next.set(node.data.subarray(0, Math.min(node.data.byteLength, next.byteLength)));
      node.data = next;
      node.mtimeMs = Date.now();
      callback(null);
    },

    ftruncate(fd: number, length: number, callback: (err: Error | null) => void): void {
      const handle = fds.get(fd);
      if (!handle) {
        callback(makeFsError("EBADF", `bad file descriptor ${fd}`));
        return;
      }
      (fsShim.truncate as (p: string, l: number, cb: (e: Error | null) => void) => void)(
        handle.path,
        length,
        callback
      );
    },

    fsync(_fd: number, callback: (err: Error | null) => void): void {
      callback(null);
    },

    chmod(filePath: string, _mode: number, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(filePath, cwd);
      callback(nodes.has(norm) ? null : makeFsError("ENOENT", norm));
    },

    fchmod(fd: number, _mode: number, callback: (err: Error | null) => void): void {
      callback(fds.has(fd) ? null : makeFsError("EBADF", String(fd)));
    },

    chown(
      filePath: string,
      _uid: number,
      _gid: number,
      callback: (err: Error | null) => void
    ): void {
      const norm = normalizePosixPath(filePath, cwd);
      callback(nodes.has(norm) ? null : makeFsError("ENOENT", norm));
    },

    fchown(
      fd: number,
      _uid: number,
      _gid: number,
      callback: (err: Error | null) => void
    ): void {
      callback(fds.has(fd) ? null : makeFsError("EBADF", String(fd)));
    },

    lchown(
      filePath: string,
      _uid: number,
      _gid: number,
      callback: (err: Error | null) => void
    ): void {
      const norm = normalizePosixPath(filePath, cwd);
      callback(nodes.has(norm) ? null : makeFsError("ENOENT", norm));
    },

    utimes(
      filePath: string,
      _atime: number,
      mtime: number,
      callback: (err: Error | null) => void
    ): void {
      const norm = normalizePosixPath(filePath, cwd);
      const node = nodes.get(norm);
      if (!node) {
        callback(makeFsError("ENOENT", norm));
        return;
      }
      node.mtimeMs = mtime * 1000;
      callback(null);
    },

    readlink(filePath: string, callback: (err: Error | null) => void): void {
      const norm = normalizePosixPath(filePath, cwd);
      callback(
        nodes.has(norm)
          ? makeFsError("EINVAL", `${baseName(norm)} is not a symlink`)
          : makeFsError("ENOENT", norm)
      );
    },

    link(_p: string, _l: string, callback: (err: Error | null) => void): void {
      callback(makeFsError("ENOSYS", "link not implemented"));
    },

    symlink(_p: string, _l: string, callback: (err: Error | null) => void): void {
      callback(makeFsError("ENOSYS", "symlink not implemented"));
    }
  };

  const processShim: Record<string, unknown> = {
    getuid: () => 0,
    getgid: () => 0,
    geteuid: () => 0,
    getegid: () => 0,
    getgroups: () => [],
    pid: 1,
    ppid: 0,
    umask: () => 0o022,
    cwd: () => cwd,
    chdir(nextDir: string) {
      const norm = normalizePosixPath(nextDir, cwd);
      const node = nodes.get(norm);
      if (!node) {
        throw makeFsError("ENOENT", `no such directory: ${norm}`);
      }
      if (node.kind !== "dir") {
        throw makeFsError("ENOTDIR", `not a directory: ${norm}`);
      }
      cwd = norm;
    }
  };

  const pathShim = {
    resolve(...segments: string[]): string {
      let acc = cwd;
      for (const seg of segments) {
        if (!seg) continue;
        acc = normalizePosixPath(seg, acc);
      }
      return acc;
    }
  };

  return {
    fs: fsShim,
    process: processShim,
    path: pathShim,
    reset(initialFiles = {}) {
      initBaseDirs();
      stdoutChunks = [];
      stderrChunks = [];
      for (const [p, content] of Object.entries(initialFiles)) {
        writeVirtualFile(p, content);
      }
    },
    writeVirtualFile,
    mkdirp,
    readVirtualFileText,
    readVirtualFileBytes,
    getStdout: () => concatChunks(stdoutChunks),
    getStderr: () => concatChunks(stderrChunks),
    clearStdio: () => {
      stdoutChunks = [];
      stderrChunks = [];
    }
  };
}
