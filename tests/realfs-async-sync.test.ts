import { fs, configure, StoreFS, InMemoryStore } from '@zenfs/core';
import { RealFSClient, RealFS } from '../src/realfs.ts';

Deno.test("RealFS async write, sync read operations", async () => {
    const client = new RealFSClient("localhost:8000/api/v1/ws");
    const syncBackend = new StoreFS(new InMemoryStore(0x400000, 'test-sync'));
    const backend = new RealFS(client, syncBackend);

    await client.ready;

    await configure({
        mounts: {
            '/': backend,
        },
        log: {
            level: 'debug',
        },
    });

    const filePath = '/test2.txt';
    const content = 'Async write, sync read';

    console.log('Writing (async)...');
    await fs.promises.writeFile(filePath, content);

    console.log('Reading (sync)...');
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        console.log("Got data back", data);
    } catch (e: any) {
        console.error('Read error:', e.message);
        throw e;
    }

    try {
        await fs.promises.unlink(filePath);
    } catch { }
    client.teardown();
});
