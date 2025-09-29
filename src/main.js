import * as zenfs from '@zenfs/core';
import * as zenfs_dom from '@zenfs/dom';
import { RealFs, RealFSClient } from './realfs';

function main() {
    return { zenfs, zenfs_dom, RealFs, RealFSClient };
}
globalThis.ZenFS_Aquire = main;
