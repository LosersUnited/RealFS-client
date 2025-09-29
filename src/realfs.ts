import { SpecBuffer } from "RealFS-ng-prototype.git#dev/real-fs-protocol/type_system.ts";
import { control_message, opcode_map, response_spec, spec } from "RealFS-ng-prototype.git#dev/real-fs-protocol/shared.ts";

import type { Backend, CreationOptions, InodeLike } from '@zenfs/core';
import { _inode_fields, Async, FileSystem, Inode } from '@zenfs/core';

// import { EventEmitter } from 'eventemitter3';

function hash32(x: number) {
    x = x >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    x = (x ^ (x >>> 16)) >>> 0;
    return x >>> 0;
}

type WriteArgs<O extends keyof typeof spec> =
    Parameters<(typeof spec)[O]["write"]> extends [SpecBuffer, ...infer P] ? P : never;

type ReadResponseArgs<O extends keyof typeof response_spec> =
    ReturnType<(typeof response_spec)[O]["read"]>;

function writeSpec<O extends keyof typeof spec>(
    op: O,
    buf: SpecBuffer,
    ...args: WriteArgs<O>
): void {
    (spec[op].write as any)(buf, ...args);
}

export class RealFSClient {
    private socket: WebSocket;
    // private emitter: EventEmitter;
    private pendingRequests = new Map<number, (buffer: SpecBuffer) => void>();

    public ready: Promise<void>;
    private nextId: number;
    constructor(url: string) {
        this.socket = new WebSocket(`ws://${url}`);
        // this.emitter = new EventEmitter();
        this.socket.onmessage = async event => {
            const data = event.data instanceof Blob ? new Uint8Array(await event.data.arrayBuffer()) : event.data;
            const buf = new SpecBuffer(data);
            const head = control_message.read(buf);
            console.log("Received head", head);
            // console.log(buf.getBuffer().length);
            // this.emitter.emit(head.id.toString(), buf);
            const callback = this.pendingRequests.get(head.id);
            if (!callback) throw new Error("Orphaned request");
            this.pendingRequests.delete(head.id);
            callback(buf);
        }
        this.ready = new Promise(resolve => {
            this.socket.onopen = () => resolve();
        })
        // this.nextId = Date.now();
        this.nextId = 1; // date overflows for some reason
    }

    public send_request<O extends keyof typeof opcode_map>(
        operation: O,
        callback: (response: ReadResponseArgs<O>) => void,
        ...params: WriteArgs<O>
    ) {
        const buffer = new SpecBuffer();
        // const id = hash32(Date.now() + Math.random() + this.nextId++);
        // this.nextId++;
        const id = this.nextId++;
        control_message.write(buffer, operation, id);
        writeSpec(operation, buffer, ...params);
        // this.emitter.once(id.toString(), (buffer: SpecBuffer) => {
        //     console.log("Got response for", id);
        //     const operation_message = response_spec[operation].read(buffer);
        //     callback(operation_message as ReadResponseArgs<O>);
        // });
        this.pendingRequests.set(id, (buffer) => {
            console.log("Got response for", id);
            const operation_message = response_spec[operation].read(buffer);
            callback(operation_message as ReadResponseArgs<O>);
        });
        this.socket.send(buffer.getBuffer());
        console.log("Sent", operation, params, id);
    }
}
type Metadata = Partial<Record<keyof InodeLike, string>>;
function stringifyStats(stats: Partial<InodeLike>): Partial<Metadata> {
    const data: Partial<Metadata> = {};
    for (const prop of _inode_fields) {
        if (prop in stats) data[prop] = stats[prop]?.toString();
    }
    return data;
}

export class RealFS extends Async(FileSystem) {
    _sync?: FileSystem | undefined;
    private readonly client: RealFSClient;
    public constructor(
        client: RealFSClient,
        sync?: FileSystem | undefined
    ) {
        super(0x7265616C, "realfs");
        this.client = client;
        this._sync = sync;
    }

    readdir(path: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            this.client.send_request("ls", (res) => {
                resolve(res.entries);
            }, path);
        });
    }

    rename(oldPath: string, newPath: string): Promise<void> {
        if (oldPath == newPath) return Promise.resolve();
        return new Promise((resolve, reject) => {
            this.client.send_request("move", (res) => {
                resolve();
            }, oldPath, newPath);
        });
    }
    stat(path: string): Promise<InodeLike> {
        return new Promise((resolve, reject) => {
            this.client.send_request("stat", res => {
                console.log("Stat response", res);
                resolve(new Inode({
                    atimeMs: Number(res.stat.atime),
                    ctimeMs: Number(res.stat.ctime),
                    mtimeMs: Number(res.stat.mtime),
                    size: res.stat.size,
                    mode: res.stat.mode,
                }));
            }, path);
        });
    }
    touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.send_request("touch", (res) => {
                resolve();
            }, path, {
                atime: BigInt(metadata.atimeMs ?? 0),
                ctime: BigInt(metadata.ctimeMs ?? 0),
                mtime: BigInt(metadata.mtimeMs ?? 0),
                size: metadata.size ?? 0,
                mode: metadata.mode ?? 0,
            });
        });
    }
    createFile(path: string, options: CreationOptions): Promise<InodeLike> {
        return new Promise((resolve, reject) => {
            this.client.send_request("new", (res) => {
                console.log("Create response", res);
                resolve(new Inode({
                    atimeMs: Number(res.result.atime),
                    ctimeMs: Number(res.result.ctime),
                    mtimeMs: Number(res.result.mtime),
                    size: res.result.size,
                    mode: res.result.mode,
                }));
            }, path, {
                mode: options.mode ?? 0o100644,
            });
        });
    }
    unlink(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.send_request("unlink", (res) => {
                console.log("Unlink response", res);
                resolve();
            }, path);
        });
    }
    rmdir(path: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.send_request("rmdir", (res) => {
                console.log("Rmdir response", res);
                resolve();
            }, path);
        });
    }
    mkdir(path: string, options: CreationOptions): Promise<InodeLike> {
        return new Promise((resolve, reject) => {
            this.client.send_request("new", (res) => {
                console.log("Mkdir response", res);
                resolve(new Inode({
                    atimeMs: Number(res.result.atime),
                    ctimeMs: Number(res.result.ctime),
                    mtimeMs: Number(res.result.mtime),
                    size: res.result.size,
                    mode: res.result.mode,
                }));
            }, path, {
                mode: options.mode ?? 0o40777,
            });
        });
    }
    link(target: string, link: string): Promise<void> {
        console.log("link", ...arguments);
        throw new Error("Method not implemented.");
    }
    read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.send_request("read", (res) => {
                console.log("Read response", res);
                buffer.set(res.data, 0);
                resolve();
            }, path, start, end);
        });
    }
    write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
        return new Promise((resolve, reject) => {
            this.client.send_request("write", (res) => {
                console.log("Write response", res);
                resolve();
            }, path, /*buffer.slice(offset)*/ buffer.subarray(offset, offset + length), offset);
        });
    }
}

export interface RealFSOptions {
    client: RealFSClient;
    sync?: FileSystem;
}

export const _RealFS = {
    name: 'RealFS',

    options: {
        client: { type: 'object', required: true },
        sync: { type: 'object', required: false },
    },

    isAvailable(): boolean {
        return true;
    },

    create(options) {
        return new RealFS(options.client, options.sync);
    },
} satisfies Backend<RealFS, RealFSOptions>;
type _RealFS = typeof _RealFS;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface RealFS_ extends _RealFS { }
export const RealFs: RealFS_ = _RealFS;
