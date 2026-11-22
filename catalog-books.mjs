import {execFile} from 'node:child_process';
import {link, lstat, mkdir, readdir, unlink} from 'node:fs/promises';
import {basename, extname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {env, pipeline} from '@huggingface/transformers';
import {cache} from './book-metadata-common.mjs';

const run = promisify(execFile);

const scripts = new Map([
    ['.pdf', fileURLToPath(new URL('./book-metadata.mjs', import.meta.url))],
    ['.djvu', fileURLToPath(new URL('./djvu-metadata.mjs', import.meta.url))],
]);

function metadataFromFilename(file) {
    const name = basename(file, extname(file)).normalize('NFC');
    const match = /^(.+?) - ((?:1\d{3}|20\d{2}|21\d{2})) - .+$/u.exec(name);
    if (!match) return null;

    const [, description, year] = match;
    const separator = description.lastIndexOf(' - ');
    if (separator < 0) return null;

    const title = description.slice(0, separator).trim();
    const author = description.slice(separator + 3).trim();
    return title && author ? {title, author, year: Number(year), file} : null;
}

async function organizeBook(model, directory, book) {
    const [{generated_text: answer}] = await model([
        {
            role: 'system',
            content: 'По названию книги определи её конкретную тему. Используй узкую тему вместо общей отрасли, когда она ясна. Ответь одной строкой на русском языке, только названием темы. Книги о математических множествах относятся к теме «теория множеств». Если тема неясна, ответь «разное».',
        },
        {role: 'user', content: 'Курс дифференциального и интегрального исчисления'},
        {role: 'assistant', content: 'математический анализ'},
        {role: 'user', content: 'Занимательные задачи о множествах'},
        {role: 'assistant', content: 'теория множеств'},
        {role: 'user', content: 'Сто рецептов домашней кухни'},
        {role: 'assistant', content: 'кулинария'},
        {role: 'user', content: book.title},
    ], {max_new_tokens: 24, do_sample: false, return_full_text: false});

    const output = Array.isArray(answer) ? answer.at(-1)?.content : answer;
    const category = output?.trim().split('\n')[0].replace(/^[«"“]+|[»"”.]+$/gu, '').trim().toLowerCase().normalize('NFC');
    if (!category || !/^[\p{L}\p{N}][\p{L}\p{N} -]{0,79}$/u.test(category)) {
        throw new Error('Модель не вернула подходящее название папки.');
    }

    const folder = resolve(directory, category);
    const destination = resolve(folder, basename(book.file));
    await mkdir(folder, {recursive: true});
    if (!(await lstat(folder)).isDirectory()) throw new Error('Путь категории должен быть обычной папкой.');
    await link(book.file, destination);
    await unlink(book.file);
    return {...book, category, file: destination};
}

async function main() {
    const directory = resolve(process.argv[2] ?? '.');
    const entries = await readdir(directory, {withFileTypes: true});
    const books = [];
    const errors = [];

    entries.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    let model;
    try {
        for (const entry of entries) {
            const file = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || ['junk', 'node_modules'].includes(entry.name)) continue;
                const children = await readdir(file, {withFileTypes: true});
                for (const child of children) {
                    if (!child.isFile() || !scripts.has(extname(child.name).toLowerCase())) continue;
                    const metadata = metadataFromFilename(resolve(file, child.name));
                    if (metadata) books.push({...metadata, category: entry.name.normalize('NFC')});
                }
                continue;
            }

            const script = scripts.get(extname(entry.name).toLowerCase());
            if (!entry.isFile() || !script) continue;

            let metadata = metadataFromFilename(file);
            try {
                if (!metadata) {
                    const {stdout} = await run(process.execPath, [script, file]);
                    metadata = JSON.parse(stdout);
                }

                env.cacheDir = cache;
                model ??= await pipeline('text-generation', 'onnx-community/Qwen2.5-1.5B-Instruct', {
                    device: 'cpu',
                    dtype: 'q4',
                });
                books.push(await organizeBook(model, directory, metadata));
            } catch (error) {
                errors.push({
                    file: metadata?.file ?? file,
                    message: error.stderr?.trim() || error.message,
                });
            }
        }
    } finally {
        await model?.dispose();
    }

    console.log(JSON.stringify({directory, books, errors}, null, 2));
    if (errors.length) process.exitCode = 1;
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
