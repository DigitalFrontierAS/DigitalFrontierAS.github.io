
var DigitalFrontierAS = (function () {
    "use strict";

    function Player(composition, baseUrl) {
        // Local, "private" variables
        let AudioContext = window.AudioContext || window.webkitAudioContext,
            context = null,
            startTime = null,
            sequences =  null,
            groups = null,
            nextAfter = null,
            nextAfterIndex = 0,
            sampleCache = {},
            duration = 0.0,
            loadAheadOffset = 0.0,
            compressorNode,
            destination,
            extensions,

            loop = null,

            LOAD_AHEAD_TIME_MAX = 10.0,
            LOAD_AHEAD_TIME_MIN = 1.0,

            TRIGGER_BUFFER = null;

        this.composition = null;

        this.currentSequence = null;
        this.currentSequenceCounter = 0;
        this.currentSequenceRevolutions = 0;

        //this.ended = false; // TODO
        this.playing = false;
        this.waiting = true;
        this.scheduleComplete = false;
        //this.readyState = 0; // TODO

        // Event handlers
        //this.onCanPlay = null; // TODO
        this.onEnded = null;
        //this.onPause = null; // TODO
        //this.onPlay = null; // TODO
        this.onPlaying = null;
        this.onWaiting = null;


        this.onSequenceStart = null;
        this.onSequenceEnd = null;
        this.onGroupStart = null;
        this.onSampleStart = null;
        this.onSampleEnd = null;
        this.onBeat = null;

        let player = this;

        if (composition) { this.load(composition, baseUrl); }


        // ------------------------------------------------------------------------------------------------
        // Structure and layout
        // ------------------------------------------------------------------------------------------------

        // Put sequences into an object for easy access
        function prepare() {
            sequences = {};
            groups = {};
            nextAfter = [];
            LOAD_AHEAD_TIME_MIN = 1.0;
            for (let i = 0; i < player.composition.sequences.length; i++) {
                const sequence = player.composition.sequences[i];
                sequences[sequence.name] = sequence;
                if (sequence.nextAfter) {
                    nextAfter.push({sequenceName: sequence.name, time: sequence.nextAfter});
                }
                for (let j = 0; j < sequence.groups.length; j++) {
                    const group = sequence.groups[j];
                    if (!group.name) group.name = "" + j;
                    const key = sequence.name + "." + group.name;
                    groups[key] = group;
                    if (group.beat < 0) {
                        let min = 1.0 - group.beat * 60.0 / sequence.bpm;
                        LOAD_AHEAD_TIME_MIN = Math.max(LOAD_AHEAD_TIME_MIN, min);
                    }
                }
            }
            nextAfter = nextAfter.sort(byTime);
            extensions = player.composition.extensions;
            if (!extensions) extensions = [];
        }


        function tearDown() {
            Object.keys(groups).forEach(function (key) {
                const group = groups[key];
                if (group.gainNode) group.gainNode = undefined;
            });
            if (context.state != "closed") context.close();
            player.playing = false;
            player.scheduleComplete = false;
        }


        function layOutSequence(sequence, layout, insertionPoint) {
            if (!layout) layout = [];
            if (!insertionPoint) insertionPoint = 0.0;
            for (let i = 0; i < sequence.groups.length; i++) {
                let group = sequence.groups[i];
                let beat = group.beat;
                if (beat > 0) beat--;
                layout.push({
                    time:     insertionPoint + beat * 60 / sequence.bpm,
                    sequence: sequence,
                    group:    group,
                    sample:   randomElement(group.samples)
                });
            }
            return layout;
        }


        function nextLoop(offset, sequenceName) {
            if (!offset) offset = 0;
            let revolutions = 0;
            let sequence;
            do {
                if (nextAfterIndex < nextAfter.length && nextAfter[nextAfterIndex].time <= offset) {
                    sequenceName = nextAfter[nextAfterIndex++].sequenceName;
                } else if (!sequenceName) {
                    sequenceName = randomElement(player.composition.start);
                } else {
                    if (!sequence) sequence = sequences[sequenceName];
                    if (!sequence) throw Error("Could not find sequence '" + sequenceName + "'");
                    sequenceName = randomElement(sequence.next);
                }
                if (!sequenceName) return null;
                sequence = sequences[sequenceName];
                if (!sequence) throw Error("Could not find sequence '" + sequenceName + "'");

                let nextAfterTime = nextAfterIndex < nextAfter.length ? nextAfter[nextAfterIndex].time - offset : Infinity;
                let divisibleBy = sequence.divisibleBy ? sequence.divisibleBy : 1;
                if (nextAfterTime <= 0.0) {
                    revolutions = divisibleBy;
                } else {
                    let sequenceLength = 60 * sequence.numBeats / sequence.bpm;
                    let maxFromNextAfterTime = (Math.floor(nextAfterTime / sequenceLength) + 1) * divisibleBy;
                    revolutions = randomNumber(sequence.minRevolutions, sequence.maxRevolutions, divisibleBy);
                    revolutions = Math.min(revolutions, maxFromNextAfterTime);
                }
            } while (revolutions === 0);

            return {
                offset: offset,
                sequenceName: sequenceName,
                revolutions: revolutions,
                counter: 0
            };
        }


        function finish() {
            tearDown();
            if (player.onEnded) player.onEnded();
        }



        // ------------------------------------------------------------------------------------------------
        // Utilities
        // ------------------------------------------------------------------------------------------------

        function byTime(a,b) {
            if (a.time < b.time) return -1;
            if (a.time > b.time) return 1;
            return 0;
        }

        function randomElement (array) {
            if (!array) return null;
            if (array.length === 0) return null;

            let sumProb = 0;
            let noProbCount = 0;
            let randomNumber = Math.random() * 100;

            for (let i = 0; i < array.length; i++) {
                let element = array[i];
                if (element.value === undefined) {
                    element = { value : element };
                    noProbCount++;
                    array[i] = element;
                } else if (element.probability === undefined) {
                    noProbCount++;
                } else {
                    sumProb += element.probability;
                }
            }

            if (sumProb > 101) throw Error("Sum of probability > 100: " + JSON.stringify(array, null, 2));
            if (sumProb < 99 && noProbCount === 0) throw Error("Sum of probability < 100: " + JSON.stringify(array, null, 2));

            let leftProb = (noProbCount === 0) ? 0.0 : (100.0 - sumProb) / noProbCount;
            sumProb = 0.0;
            for (let i = 0; i < array.length; i++) {
                let element = array[i];
                if (element.probability === undefined) element.probability = leftProb;
                sumProb += element.probability;
                if (randomNumber < sumProb) return element.value;
            }

            return array[array.length-1];
        }


        function randomNumber(fromInclusive, toInclusive, divisibleBy) {
            if (!divisibleBy) divisibleBy = 1;
            return fromInclusive + Math.floor(Math.random() * (toInclusive - fromInclusive + divisibleBy) / divisibleBy) * divisibleBy;
        }



        // ------------------------------------------------------------------------------------------------
        // Public interface
        // ------------------------------------------------------------------------------------------------


        this.load = function (composition, baseUrl) {
            this.composition = composition;
            this.baseUrl = baseUrl;
            this.waiting = true;
            this.scheduleComplete = false;
            if (!baseUrl) baseUrl = "";
            baseUrl = baseUrl.trim();
            if (baseUrl.length > 0 && !baseUrl.endsWith("/")) baseUrl += "/";

            prepare();
            loadAheadOffset = 0.0;
        };

        this.play = function () {
            this.currentSequence = null;
            this.currentSequenceCounter = 0;
            this.currentSequenceRevolutions = 0;

            this.ended = false;
            this.waiting = true;
            this.scheduleComplete = false;
            this.playing = true;

            if (context && context.state !== "closed") context.close();
            context = new AudioContext();
            context.suspend();
            if (!TRIGGER_BUFFER) TRIGGER_BUFFER = context.createBuffer(1, 1, context.sampleRate);

            compressorNode = context.createDynamicsCompressor();
            compressorNode.connect(context.destination);

            destination = compressorNode;
            this.refreshCompressor(this.composition.compressor);

            //destination = context.destination;

            startTime = context.currentTime;
            loop = null;
            firstTime = true;
            loadAheadOffset = 0.0;
            nextAfterIndex = 0;
            loadAhead();
        };

        this.stop = function () {
            tearDown();
        };

        this.pause = function () {
            if (context.state != "closed") context.suspend();
        };

        this.resume = function () {
            if (context.state != "closed") context.resume();
        };

        this.currentTime = function () {
            return context.currentTime - startTime;
        };

        this.refresh = function (composition) {
            if (!this.composition) return;
            this.refreshCompressor(composition.compressor);
            for (let i = 0; i < composition.sequences.length; i++) {
                const sequence = composition.sequences[i];
                for (let j = 0; j < sequence.groups.length; j++) {
                    const group = sequence.groups[j];
                    let groupName = group.name;
                    if (!groupName) groupName = "" + j;
                    this.refreshGain(sequence.name, groupName, group.gain);
                }
            }
        };

        this.refreshGain = function (sequenceName, groupName, gain) {
            const key = sequenceName + "." + groupName;
            const group = groups[key];
            if (group && group.gainNode) {
                if (gain === undefined) {
                    group.gainNode.gain.value = 1;
                } else {
                    group.gainNode.gain.value = gain;
                }
            }
        };

        this.refreshCompressor = function (c) {
            if (compressorNode) {
                if (!c) c = this.composition && this.composition.compressor;
                if (c) {
                    compressorNode.threshold.value = (c.threshold === undefined) ? -50 : c.threshold;
                    compressorNode.knee.value = (c.knee === undefined) ? 40 : c.knee;
                    // In Web Audio API 20 means no compression, 1 means full compression. This is backwards compared to what
                    // a musician would expect, which is that 1 means no compression and 20 means full compression.
                    compressorNode.ratio.value = (!c.ratio) ? 12 : 21 - c.ratio;
                    compressorNode.attack.value = (c.attack === undefined) ? 0 : c.attack;
                    compressorNode.release.value = (c.release === undefined) ? 0.25 : c.release;
                } else {
                    compressorNode.ratio.value = 20;
                }
            }
        };

        this.schedule = function (offset, fn) {
            if (fn) {
                let source = context.createBufferSource();
                source.buffer = TRIGGER_BUFFER;
                source.connect(destination);
                source.onended = function () { fn(offset); };
                source.start(startTime + offset);
            }
        };


        function checkLoadAheadStatus() {
            if (!player.playing) return;
            if (player.scheduleComplete) return;
            var loadAheadTime = loadAheadOffset - player.currentTime();
            if (loadAheadTime < LOAD_AHEAD_TIME_MIN) {
                if (!player.waiting) {
                    context.suspend();
                    player.waiting = true;
                    if (player.onWaiting) player.onWaiting();
                }
            } else if (player.waiting && loadAheadTime > 2 * LOAD_AHEAD_TIME_MIN) {
                context.resume();
                player.waiting = false;
                if (player.onPlaying) player.onPlaying();
            }
        }

        setInterval(checkLoadAheadStatus, 100);


        let firstTime = true;

        function loadAhead() {
            if (!player.playing) return;
            if (firstTime) {
                loop = nextLoop();
                firstTime = false;
                scheduleLoop();
                return;
            }
            if (!loop) return;
            let nextOffset = loop.nextOffset;
            if (nextOffset && nextOffset - player.currentTime() < LOAD_AHEAD_TIME_MAX) {
                let counter = loop.counter;
                counter++;
                if (counter == loop.revolutions) {
                    loop = nextLoop(nextOffset, loop.sequenceName);
                } else {
                    loop = {
                        offset: nextOffset,
                        sequenceName: loop.sequenceName,
                        revolutions: loop.revolutions,
                        counter: counter
                    };
                }
                if (loop) {
                    scheduleLoop();
                } else {
                    // Nothing more to play
                    player.schedule(nextOffset, function () {
                        player.currentSequence = null;
                        player.currentSequenceCounter = 0;
                        player.currentSequenceRevolutions = 0;
                    });
                    player.schedule(duration, finish);
                    player.scheduleComplete = true;
                }
            }
        }


        setInterval(loadAhead, 100);


        // ------------------------------------------------------------------------------------------------
        // Scheduling
        // ------------------------------------------------------------------------------------------------

        function scheduleLoop() {
            let sequence = sequences[loop.sequenceName];

            let layout = layOutSequence(sequence);

            if (loop.offset + layout[0].time < 0.0) {
                // This should only happen the very first loop, in case of "prelude"
                loop.offset -= layout[0].time;
            }
            let offset = loop.offset;

            let nextOffset = offset + sequence.numBeats * 60.0 / sequence.bpm; // Next sequence starts here
            let currentLoop = loop;
            player.schedule(offset, function () {
                player.currentSequence = currentLoop.sequenceName;
                player.currentSequenceCounter = currentLoop.counter;
                player.currentSequenceRevolutions = currentLoop.revolutions;
                if (player.onSequenceStart) player.onSequenceStart(offset, currentLoop.sequenceName, currentLoop.counter, currentLoop.revolutions);
            });
            player.schedule(nextOffset, function () {
                if (player.onSequenceEnd) player.onSequenceEnd(nextOffset, currentLoop.sequenceName, currentLoop.counter, currentLoop.revolutions);
            });
            scheduleLayout(layout, offset, function () {
                loadAheadOffset = Math.max(loadAheadOffset, nextOffset);
                currentLoop.nextOffset = nextOffset;
            });
        }


        function scheduleLayout(layout, offset, ondone) {
            let counter = layout.length;
            function andThen () {
                counter--;
                if (ondone && counter === 0) ondone();
            }
            for (let i = 0; i < layout.length; i++) {
                let element = layout[i];
                scheduleElement(element, offset, andThen);
            }
        }


        function scheduleElement(element, offset, ondone) {
            let sample = element.sample;
            let buffer = sampleCache[sample];
            const currentContext = context;
            if (buffer) {
                scheduleBuffer(currentContext, element.sequence, element.group, sample, buffer, offset + element.time);
                if (ondone) ondone();
            } else {
                loadSample(sample, function (buffer) {
                    scheduleBuffer(currentContext, element.sequence, element.group, sample, buffer, offset + element.time);
                    if (ondone) ondone();
                });
            }
        }


        function loadSample(sample, ondone, exts) {
            const request = new XMLHttpRequest();
            if (!exts) exts = extensions;
            let url = sample;
            if (player.baseUrl) url = player.baseUrl + url;
            if (exts.length > 0) {
                const dotPos = url.lastIndexOf(".");
                if (dotPos > 0) url = url.substring(0, dotPos);
                url += exts[0];
            }
            request.open('GET', url, true);
            request.responseType = 'arraybuffer';
            request.onloadend = function () {
                if (request.status === 404) {
                    if (exts.length > 0) {
                        exts.shift();
                        loadSample(sample, ondone, exts);
                    }
                } else if (request.status === 200) {
                    context.decodeAudioData(request.response, function (buffer) {
                        sampleCache[sample] = buffer;
                        if (ondone) ondone(buffer);
                    });
                }
            };
            request.send();
        }

        function getGainNode(sequenceName, groupName) {
            const key = sequenceName + "." + groupName;
            const group = groups[key];
            if (!group.gainNode) {
                group.gainNode = context.createGain();
                group.gainNode.gain.value = (group.gain === undefined) ? 1.0 : group.gain;
                group.gainNode.connect(destination);
            }
            return group.gainNode;
        }

        function scheduleBuffer(context, sequence, group, sample, buffer, offset) {
            if (context.state === "closed") return;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(getGainNode(sequence.name, group.name));
            if (player.onSampleStart) player.schedule(offset, function (offs) { player.onSampleStart(offs, sample, buffer); });
            if (player.onSampleEnd) source.onended = function () { player.onSampleEnd(offset + buffer.duration, sample, buffer); };
            duration = Math.max(duration, offset + buffer.duration);
            source.start(startTime + offset);
        }

    }


    return {
        Player: Player
    };

})();
