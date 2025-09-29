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
        this.socket.binaryType = "arraybuffer";
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
        ...params: WriteArgs<O>
    ): Promise<ReadResponseArgs<O>> {
        const buffer = new SpecBuffer();
        const id = this.nextId++;
        control_message.write(buffer, operation, id);
        writeSpec(operation, buffer, ...params);
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, (buf) => {
                try {
                    console.log("Got response for", id);
                    const res = response_spec[operation].read(buf);
                    resolve(res as ReadResponseArgs<O>);
                } catch (err) {
                    reject(err);
                }
            });
            this.socket.send(buffer.getBuffer());
            console.log("Sent", operation, params, id);
        });
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

    async readdir(path: string) {
        return (await this.client.send_request("ls", path)).entries;
    }

    async rename(oldPath: string, newPath: string) {
        if (oldPath == newPath) return;
        await this.client.send_request("move", oldPath, newPath);
    }
    async stat(path: string) {
        const res = await this.client.send_request("stat", path);
        return new Inode({
            atimeMs: Number(res.stat.atime),
            ctimeMs: Number(res.stat.ctime),
            mtimeMs: Number(res.stat.mtime),
            size: res.stat.size,
            mode: res.stat.mode,
        });
    }
    async touch(path: string, metadata: Partial<InodeLike>) {
        await this.client.send_request("touch", path, {
            atime: BigInt(metadata.atimeMs ?? 0),
            ctime: BigInt(metadata.ctimeMs ?? 0),
            mtime: BigInt(metadata.mtimeMs ?? 0),
            size: metadata.size ?? 0,
            mode: metadata.mode ?? 0,
        });
    }
    async createFile(path: string, options: CreationOptions) {
        const res = await this.client.send_request("new", path, {
            mode: options.mode ?? 0o100644,
        });

        return new Inode({
            atimeMs: Number(res.result.atime),
            ctimeMs: Number(res.result.ctime),
            mtimeMs: Number(res.result.mtime),
            size: res.result.size,
            mode: res.result.mode,
        });
    }
    async unlink(path: string) {
        await this.client.send_request("unlink", path);
    }
    async rmdir(path: string) {
        await this.client.send_request("rmdir", path);
    }
    async mkdir(path: string, options: CreationOptions) {
        const res = await this.client.send_request("new", path, {
            mode: options.mode ?? 0o40777,
        })

        return new Inode({
            atimeMs: Number(res.result.atime),
            ctimeMs: Number(res.result.ctime),
            mtimeMs: Number(res.result.mtime),
            size: res.result.size,
            mode: res.result.mode,
        });
    }
    link(target: string, link: string): Promise<void> {
        console.log("link", ...arguments);
        throw new Error("Method not implemented.");
    }
    async read(path: string, buffer: Uint8Array, start: number, end: number) {
        const res = await this.client.send_request("read", path, start, end);
        buffer.set(res.data, 0);
    }
    async write(path: string, buffer: Uint8Array, offset: number) {
        await this.client.send_request("write", path, buffer.subarray(offset, offset + length), offset);
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
