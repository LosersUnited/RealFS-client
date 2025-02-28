import * as zenfs from '@zenfs/core';
import * as zenfs_dom from '@zenfs/dom';

function main() {
    return { zenfs, zenfs_dom };
}
globalThis.ZenFS_Aquire = main;
