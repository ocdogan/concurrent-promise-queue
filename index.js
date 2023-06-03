'use strict';
const MAX_CONCURRENCY = 500;
const MAX_SLEEP_DURATION = 10000;

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_SLEEP_DURATION = 5;

module.exports = function ConcurrentPromiseQueue(
    options = {
        concurrency: DEFAULT_CONCURRENCY,
        sleepDuration: DEFAULT_SLEEP_DURATION,
        maxTaskLength: 0,
        onError: void (0),
        onComplete: void (0),
    }
) {
    const self = this;
    options = { ...options };

    const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, (Math.max(0, Number(options.concurrency) || 0) || DEFAULT_CONCURRENCY)));
    const sleepDuration = Math.min(MAX_SLEEP_DURATION, Math.max(1, (Math.max(0, Number(options.sleepDuration) || 0) || DEFAULT_SLEEP_DURATION)));
    const maxTaskLength = Math.max(0, Number(options.maxTaskLength) || 0);

    const onError = typeof options.onError === 'function' ? options.onError : void (0);
    const onComplete = typeof options.onComplete === 'function' ? options.onComplete : void (0);

    const concurrentPromises = new Map();

    let taskQueue = [];
    let running = false;
    let sleepHandler = void (0);

    function makeCancelable(promise) {
        let rejectFn;
        let canceled = false;

        const cancelable = new Promise((resolve, reject) => {
            rejectFn = reject;
            Promise.resolve(promise)
                .then(resolve)
                .catch(reject);
        });

        cancelable.cancel = () => {
            let alreadyCanceled;
            [canceled, alreadyCanceled] = [canceled, true];

            if (!alreadyCanceled) {
                rejectFn({ canceled: true });
            }
        };

        cancelable.canceled = () => canceled;

        return cancelable;
    }

    async function sleep(ms = 0) {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                try {
                    resolve();
                } catch {
                } finally {
                    clearTimeout(timeoutId);
                }
            }, ms);
        });
    }

    async function push(fn) {
        if (typeof fn !== 'function') {
            return;
        }
        taskQueue.push(fn);
        await start();
    }

    function handleError(error) {
        try {
            if (onError) {
                onError(error);
            }
        } catch { }
    }

    function doComplete(result) {
        try {
            if (onComplete && Array.isArray(result)) {
                const [fn, response] = result;
                onComplete(fn, response);
            }
        } catch { }
    }

    async function call(fn) {
        return [fn, (await fn())];
    }

    async function process() {
        let id = 0;
        while (running) {
            const freeSlotsCount = Math.max(0, concurrency - concurrentPromises.size);
            if (!freeSlotsCount || !taskQueue.length) {
                await (sleepHandler = makeCancelable(sleep(sleepDuration)));
                continue;
            }

            const fn = taskQueue.splice(0, 1)[0];

            id = (id === Number.MAX_SAFE_INTEGER ? 0 : ++id);

            const symbol = Symbol(id);
            concurrentPromises.set(symbol, fn);

            makeCancelable(call(fn))
                .then(doComplete)
                .catch(handleError)
                .finally(() => concurrentPromises.delete(symbol));
        }

        if (concurrentPromises.size) {
            const remaning = new Array(concurrentPromises.values());
            concurrentPromises.clear();

            if (remaning.length) {
                remaning
                    .filter(promise => typeof promise.cancel === 'function')
                    .forEach((promise) => promise.cancel());
            }
        }
    }

    async function start() {
        let sleepPromise;
        [sleepHandler, sleepPromise] = [sleepHandler, void (0)];
        if (sleepPromise) {
            sleepPromise.cancel();
        }

        let alreadyRunning;
        [running, alreadyRunning] = [true, running];
        if (alreadyRunning) {
            return;
        }

        return await Promise.resolve(1)
            .then(() => process())
            .finally(stop);
    }

    function stop() {
        running = false;
        taskQueue = [];
    }

    const proto = {
        push: async (fn) => {
            while (maxTaskLength &&
                (taskQueue.length >= maxTaskLength)) {
                await sleep(1);
            }
            push(fn);
            await sleep(0);
        },
        stop,

        get running() { return running; },
        get length() { return taskQueue.length; },
        get currentConcurrency() { return concurrentPromises.size; }
    };

    Object.setPrototypeOf(self, proto);
    return self;
};