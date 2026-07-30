const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.ts', '.m2ts', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp', '.divx']);
const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa', '.sub'];
const MIME_TYPE_BY_EXTENSION = {
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.ts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.wmv': 'video/x-ms-wmv',
    '.flv': 'video/x-flv',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
    '.3gp': 'video/3gpp',
    '.divx': 'video/x-msvideo'
};
const IDENTIFIER_LENGTH = 16;
const MAXIMUM_SCAN_DEPTH = 8;
const SKIPPED_DIRECTORY_NAMES = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git']);
const MINIMUM_VIDEO_SIZE_BYTES = 2 * 1024 * 1024;

function buildIdentifier(absolutePath) {
    return crypto.createHash('sha1').update(absolutePath.toLowerCase()).digest('hex').slice(0, IDENTIFIER_LENGTH);
}

function prettifyTitle(fileName) {
    const withoutExtension = fileName.replace(/\.[^.]+$/, '');
    return withoutExtension
        .replace(/[._]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function findSidecarSubtitle(videoPath) {
    const directory = path.dirname(videoPath);
    const baseName = path.basename(videoPath).replace(/\.[^.]+$/, '');
    for (const extension of SUBTITLE_EXTENSIONS) {
        const candidate = path.join(directory, baseName + extension);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return '';
}

function scanDirectory(directoryPath, rootPath, depth, collected) {
    if (depth > MAXIMUM_SCAN_DEPTH) {
        return;
    }
    let entries = [];
    try {
        entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch (error) {
        void error;
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            if (SKIPPED_DIRECTORY_NAMES.has(entry.name) === false && entry.name.startsWith('.') === false) {
                scanDirectory(fullPath, rootPath, depth + 1, collected);
            }
        } else if (entry.isFile()) {
            const extension = path.extname(entry.name).toLowerCase();
            if (VIDEO_EXTENSIONS.has(extension)) {
                let stats = null;
                try {
                    stats = fs.statSync(fullPath);
                } catch (error) {
                    void error;
                }
                if (stats && stats.size >= MINIMUM_VIDEO_SIZE_BYTES) {
                    collected.push({
                        id: buildIdentifier(fullPath),
                        filePath: fullPath,
                        title: prettifyTitle(entry.name),
                        fileName: entry.name,
                        folder: path.relative(rootPath, path.dirname(fullPath)) || path.basename(rootPath),
                        root: rootPath,
                        sizeBytes: stats.size,
                        modifiedAt: stats.mtimeMs,
                        mimeType: MIME_TYPE_BY_EXTENSION[extension] || 'video/mp4',
                        extension,
                        subtitlePath: findSidecarSubtitle(fullPath)
                    });
                }
            }
        }
    }
}

function scanLibrary(rootPaths) {
    const collected = [];
    for (const rootPath of rootPaths) {
        if (fs.existsSync(rootPath)) {
            scanDirectory(rootPath, rootPath, 0, collected);
        }
    }
    collected.sort((left, right) => right.modifiedAt - left.modifiedAt);
    return collected;
}

function filterLibrary(items, queryText) {
    const normalizedQuery = String(queryText || '').trim().toLowerCase();
    if (normalizedQuery === '') {
        return items;
    }
    const terms = normalizedQuery.split(/\s+/);
    return items.filter((item) => {
        const haystack = `${item.title} ${item.folder}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
    });
}

module.exports = { scanLibrary, filterLibrary, MIME_TYPE_BY_EXTENSION };
