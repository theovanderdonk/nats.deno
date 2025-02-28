/*
 * Copyright 2021-2023 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { NatsServer } from "../../tests/helpers/launcher.ts";

import { initStream, time } from "./jstest_util.ts";
import {
  AckPolicy,
  checkJsError,
  ConsumerConfig,
  ConsumerOpts,
  consumerOpts,
  DeliverPolicy,
  JsHeaders,
  JsMsg,
  JsMsgCallback,
  nanos,
  PubAck,
  RepublishHeaders,
  RetentionPolicy,
  StorageType,
} from "../mod.ts";
import {
  collect,
  delay,
  NatsConnectionImpl,
} from "../../nats-base-client/internal_mod.ts";
import {
  createInbox,
  DebugEvents,
  deferred,
  Empty,
  ErrorCode,
  Events,
  headers,
  JSONCodec,
  NatsError,
  nuid,
  QueuedIterator,
  StringCodec,
} from "../../nats-base-client/mod.ts";
import {
  assertArrayIncludes,
  assertEquals,
  assertExists,
  assertIsError,
  assertRejects,
  assertThrows,
  fail,
} from "https://deno.land/std@0.200.0/assert/mod.ts";

import { assert } from "../../nats-base-client/denobuffer.ts";
import {
  JetStreamClientImpl,
  JetStreamSubscriptionImpl,
  PubHeaders,
} from "../jsclient.ts";
import { defaultJsOptions } from "../jsbaseclient_api.ts";
import { connect } from "../../src/connect.ts";
import {
  assertBetween,
  cleanup,
  disabled,
  jetstreamExportServerConf,
  jetstreamServerConf,
  Lock,
  notCompatible,
  setup,
} from "../../tests/helpers/mod.ts";
import { isFlowControlMsg, isHeartbeatMsg, Js409Errors } from "../jsutil.ts";
import {
  ConsumerOptsBuilderImpl,
  JetStreamSubscriptionInfoable,
} from "../types.ts";
import { syncIterator } from "../../nats-base-client/core.ts";

function callbackConsume(debug = false): JsMsgCallback {
  return (err: NatsError | null, jm: JsMsg | null) => {
    if (err) {
      switch (err.code) {
        case ErrorCode.JetStream408RequestTimeout:
        case ErrorCode.JetStream409:
        case ErrorCode.JetStream404NoMessages:
          return;
        default:
          fail(err.code);
      }
    }
    if (debug && jm) {
      console.dir(jm.info);
      if (jm.headers) {
        console.info(jm.headers.toString());
      }
    }
    if (jm) {
      jm.ack();
    }
  };
}

async function consume(iter: QueuedIterator<JsMsg>): Promise<JsMsg[]> {
  const buf: JsMsg[] = [];
  await (async () => {
    for await (const m of iter) {
      m.ack();
      buf.push(m);
    }
  })();
  return buf;
}

Deno.test("jetstream - default options", () => {
  const opts = defaultJsOptions();
  assertEquals(opts, { apiPrefix: "$JS.API", timeout: 5000 });
});

Deno.test("jetstream - default override timeout", () => {
  const opts = defaultJsOptions({ timeout: 1000 });
  assertEquals(opts, { apiPrefix: "$JS.API", timeout: 1000 });
});

Deno.test("jetstream - default override prefix", () => {
  const opts = defaultJsOptions({ apiPrefix: "$XX.API" });
  assertEquals(opts, { apiPrefix: "$XX.API", timeout: 5000 });
});

Deno.test("jetstream - options rejects empty prefix", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  assertThrows(() => {
    nc.jetstream({ apiPrefix: "" });
  });
  await cleanup(ns, nc);
});

Deno.test("jetstream - options removes trailing dot", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream({ apiPrefix: "hello." }) as JetStreamClientImpl;
  assertEquals(js.opts.apiPrefix, "hello");
  await cleanup(ns, nc);
});

Deno.test("jetstream - find stream throws when not found", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream() as JetStreamClientImpl;
  await assertRejects(
    async () => {
      await js.findStream("hello");
    },
    Error,
    "no stream matches subject",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish basic", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  let pa = await js.publish(subj);
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  pa = await js.publish(subj);
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - ackAck", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  await js.publish(subj);

  const ms = await js.pull(stream, "me");
  assertEquals(await ms.ackAck(), true);
  assertEquals(await ms.ackAck(), false);
  await cleanup(ns, nc);
});

Deno.test("jetstream - publish id", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  const pa = await js.publish(subj, Empty, { msgID: "a" });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  const jsm = await nc.jetstreamManager();
  const sm = await jsm.streams.getMessage(stream, { seq: 1 });
  assertEquals(sm.header.get(PubHeaders.MsgIdHdr), "a");

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { expect: { streamName: "xxx" } });
    },
    Error,
    "expected stream does not match",
    undefined,
  );

  const pa = await js.publish(subj, Empty, { expect: { streamName: stream } });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last message id", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  let pa = await js.publish(subj, Empty, { msgID: "a" });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 1);

  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { msgID: "b", expect: { lastMsgID: "b" } });
    },
    Error,
    "wrong last msg id: a",
    undefined,
  );

  pa = await js.publish(subj, Empty, {
    msgID: "b",
    expect: { lastMsgID: "a" },
  });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - get message last by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));

  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  await jsm.streams.add({ name: stream, subjects: [`${stream}.*`] });

  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(`${stream}.A`, sc.encode("a"));
  await js.publish(`${stream}.A`, sc.encode("aa"));
  await js.publish(`${stream}.B`, sc.encode("b"));
  await js.publish(`${stream}.B`, sc.encode("bb"));

  const sm = await jsm.streams.getMessage(stream, {
    last_by_subj: `${stream}.A`,
  });
  assertEquals(sc.decode(sm.data), "aa");

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish first sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await assertRejects(
    async () => {
      await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
    },
    Error,
    "wrong last sequence",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last sequence", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });

  await assertRejects(
    async () => {
      await js.publish(subj, Empty, {
        msgID: "b",
        expect: { lastSequence: 2 },
      });
    },
    Error,
    "wrong last sequence: 1",
    undefined,
  );

  const pa = await js.publish(subj, Empty, {
    msgID: "b",
    expect: { lastSequence: 1 },
  });
  assertEquals(pa.stream, stream);
  assertEquals(pa.duplicate, false);
  assertEquals(pa.seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - publish require last sequence by subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  await jsm.streams.add({ name: stream, subjects: [`${stream}.*`] });

  const js = nc.jetstream();

  await js.publish(`${stream}.A`, Empty);
  await js.publish(`${stream}.B`, Empty);
  const pa = await js.publish(`${stream}.A`, Empty, {
    expect: { lastSubjectSequence: 1 },
  });
  for (let i = 0; i < 100; i++) {
    await js.publish(`${stream}.B`, Empty);
  }
  // this will only succeed if the last recording sequence for the subject matches
  await js.publish(`${stream}.A`, Empty, {
    expect: { lastSubjectSequence: pa.seq },
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - ephemeral push", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);
  const js = nc.jetstream();
  await js.publish(subj);

  const opts = {
    max: 1,
    config: { deliver_subject: createInbox() },
  } as ConsumerOpts;
  opts.callbackFn = callbackConsume();
  const sub = await js.subscribe(subj, opts);
  await sub.closed;
  assertEquals(sub.getProcessed(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - durable", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();
  await js.publish(subj);

  const opts = consumerOpts();
  opts.durable("me");
  opts.manualAck();
  opts.ackExplicit();
  opts.maxMessages(1);
  opts.deliverTo(createInbox());

  let sub = await js.subscribe(subj, opts);
  const done = await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();

  await done;
  assertEquals(sub.getProcessed(), 1);

  // consumer should exist
  const jsm = await nc.jetstreamManager();
  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.name, "me");

  // delete the consumer
  sub = await js.subscribe(subj, opts);
  await sub.destroy();
  await assertRejects(
    async () => {
      await jsm.consumers.info(stream, "me");
    },
    Error,
    "consumer not found",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - queue error checks", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();

  await assertRejects(
    async () => {
      const opts = consumerOpts();
      opts.durable("me");
      opts.deliverTo("x");
      opts.queue("x");
      opts.idleHeartbeat(1000);

      await js.subscribe(subj, opts);
    },
    Error,
    "jetstream idle heartbeat is not supported with queue groups",
    undefined,
  );

  await assertRejects(
    async () => {
      const opts = consumerOpts();
      opts.durable("me");
      opts.deliverTo("x");
      opts.queue("x");
      opts.flowControl();

      await js.subscribe(subj, opts);
    },
    Error,
    "jetstream flow control is not supported with queue groups",
    undefined,
  );

  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_group: "x",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "x",
  });

  await assertRejects(
    async () => {
      await js.subscribe(subj, {
        stream: stream,
        config: { durable_name: "me", deliver_group: "y" },
      });
    },
    Error,
    "durable requires queue group 'x'",
    undefined,
  );

  await jsm.consumers.add(stream, {
    durable_name: "memo",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "z",
  });

  await assertRejects(
    async () => {
      await js.subscribe(subj, {
        stream: stream,
        config: { durable_name: "memo", deliver_group: "y" },
      });
    },
    Error,
    "durable requires no queue group",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull no messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    "no messages",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  await js.publish(subj, Empty, { msgID: "a" });
  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  const jm = await js.pull(stream, "me");
  jm.ack();
  await nc.flush();
  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 1);
  assertEquals(ci.ack_floor.stream_seq, 1, JSON.stringify(ci));

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch expires waits", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  const start = Date.now();
  const iter = js.fetch(stream, "me", { expires: 1000 });
  await (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })();
  const elapsed = Date.now() - start;
  assertBetween(elapsed, 950, 1050);
  assertEquals(iter.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch expires waits after initial", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  await js.publish(subj, Empty);
  const start = Date.now();
  const iter = js.fetch(stream, "me", { expires: 1000, batch: 5 });
  await (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })();
  const elapsed = Date.now() - start;
  assertBetween(elapsed, 950, 1050);
  assertEquals(iter.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch expires or no_wait is required", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  assertThrows(
    () => {
      js.fetch(stream, "me");
    },
    Error,
    "expires or no_wait is required",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch: no_wait with more left", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  await js.publish(subj);
  await js.publish(subj);

  const iter = js.fetch(stream, "me", { no_wait: true });
  await consume(iter);

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch some messages", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  // try to get messages = none available
  let sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 0);

  // seed some messages
  await js.publish(subj, Empty, { msgID: "a" });
  await js.publish(subj, Empty, { msgID: "b" });
  await js.publish(subj, Empty, { msgID: "c" });

  // try to get 2 messages - OK
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 2);

  await nc.flush();
  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  // try to get 2 messages - OK, but only gets 1
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 1);

  await nc.flush();
  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 3);
  assertEquals(ci.ack_floor.stream_seq, 3);

  // try to get 2 messages - OK, none available
  sub = await js.fetch(stream, "me", { batch: 2, no_wait: true });
  await (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })();
  assertEquals(sub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - max ack pending", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const jsm = await nc.jetstreamManager();
  const sc = StringCodec();
  const d = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];
  const buf: Promise<PubAck>[] = [];
  const js = nc.jetstream();
  d.forEach((v) => {
    buf.push(js.publish(subj, sc.encode(v), { msgID: v }));
  });
  await Promise.all(buf);

  const consumers = await jsm.consumers.list(stream).next();
  assert(consumers.length === 0);

  const opts = consumerOpts();
  opts.maxAckPending(2);
  opts.maxMessages(10);
  opts.manualAck();
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  await (async () => {
    for await (const m of sub) {
      assert(
        sub.getPending() < 3,
        `didn't expect pending messages greater than 2`,
      );
      m.ack();
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("jetstream - ephemeral options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  const v = await jsm.consumers.add(stream, {
    inactive_threshold: nanos(1000),
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(v.config.inactive_threshold, nanos(1000));
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer options", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  const v = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_batch: 10,
    max_expires: nanos(20000),
  });

  assertEquals(v.config.max_batch, 10);
  assertEquals(v.config.max_expires, nanos(20000));

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - attached iterator", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const jc = JSONCodec<number>();

  let sum = 0;
  const opts = consumerOpts();
  opts.durable("me");

  const js = nc.jetstream();
  const sub = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of sub) {
      assert(msg);
      //@ts-ignore: test
      const ne = checkJsError(msg.msg);
      if (ne) {
        console.log(ne.message);
      }
      const n = jc.decode(msg.data);
      sum += n;
      msg.ack();
    }
  })().then();
  sub.pull({ expires: 500, batch: 5 });

  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, true);
  await delay(250);
  assertEquals(sum, 0);

  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 0);
  assertEquals(ci.ack_floor.stream_seq, 0);

  await js.publish(subj, jc.encode(1), { msgID: "1" });
  await js.publish(subj, jc.encode(2), { msgID: "2" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(500);
  assertEquals(sum, 3);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await js.publish(subj, jc.encode(3), { msgID: "3" });
  await js.publish(subj, jc.encode(5), { msgID: "4" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(1000);
  assertEquals(sum, 11);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 4);
  assertEquals(ci.ack_floor.stream_seq, 4);

  await js.publish(subj, jc.encode(7), { msgID: "5" });

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - attached callback", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const jc = JSONCodec<number>();

  let sum = 0;
  const opts = consumerOpts();
  opts.durable("me");

  opts.callback((err, msg) => {
    if (err) {
      switch (err.code) {
        case ErrorCode.JetStream408RequestTimeout:
        case ErrorCode.JetStream409:
        case ErrorCode.JetStream404NoMessages:
          return;
        default:
          fail(err.code);
      }
    }
    if (msg) {
      const n = jc.decode(msg.data);
      sum += n;
      msg.ack();
    }
  });

  const js = nc.jetstream();
  const sub = await js.pullSubscribe(subj, opts);
  sub.pull({ expires: 500, batch: 5 });
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, true);
  await delay(250);
  assertEquals(sum, 0);

  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 0);
  assertEquals(ci.ack_floor.stream_seq, 0);

  await js.publish(subj, jc.encode(1), { msgID: "1" });
  await js.publish(subj, jc.encode(2), { msgID: "2" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(500);
  assertEquals(sum, 3);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await js.publish(subj, jc.encode(3), { msgID: "3" });
  await js.publish(subj, jc.encode(5), { msgID: "4" });
  sub.pull({ expires: 500, batch: 5 });
  await delay(1000);
  assertEquals(sum, 11);

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 4);
  assertEquals(ci.ack_floor.stream_seq, 4);

  await js.publish(subj, jc.encode(7), { msgID: "5" });

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - not attached callback", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj);

  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.maxMessages(1);
  opts.callback(callbackConsume(false));

  const sub = await js.pullSubscribe(subj, opts);
  sub.pull();
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);
  await sub.closed;

  const jsm = await nc.jetstreamManager();
  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 1);
  assertEquals(ci.ack_floor.stream_seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub requires explicit", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();

  await assertRejects(
    async () => {
      const opts = consumerOpts();
      opts.durable("me");
      opts.ackAll();
      await js.pullSubscribe(subj, opts);
    },
    Error,
    "ack policy for pull",
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub ephemeral", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj);

  const d = deferred<JsMsg>();
  const opts = consumerOpts();

  opts.ackExplicit();
  opts.callback((err, msg) => {
    if (err) {
      d.reject(err);
    } else {
      d.resolve(msg!);
    }
  });

  const ps = await js.pullSubscribe(subj, opts);
  ps.pull({ no_wait: true });
  const r = await d;
  assertEquals(r.subject, subj);
  await cleanup(ns, nc);
});

Deno.test("jetstream - subscribe - not attached callback", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.callback(callbackConsume(false));
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);

  await delay(500);
  sub.unsubscribe();
  await nc.flush();

  const jsm = await nc.jetstreamManager();
  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 5);
  assertEquals(ci.ack_floor.stream_seq, 5);

  await cleanup(ns, nc);
});

Deno.test("jetstream - subscribe - not attached non-durable", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.callback(callbackConsume());
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);
  await delay(500);
  assertEquals(sub.getProcessed(), 5);
  sub.unsubscribe();

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - breaks after expires", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const m of batch) {
      console.log(m.info);
      fail("expected no messages");
    }
  })();

  await done;
  sw.mark();
  sw.assertInRange(1000);
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - no wait breaks fast", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    no_wait: true,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  assertBetween(sw.duration(), 0, 500);
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch one - no wait breaks fast", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  await js.publish(subj);

  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    no_wait: true,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  console.log({ duration: sw.duration() });
  const duration = sw.duration();
  assert(25 > duration, `${duration}`);
  assertEquals(batch.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch none - cancel timers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  const nci = nc as NatsConnectionImpl;
  const last = nci.protocol.subscriptions.sidCounter;
  const sub = nci.protocol.subscriptions.get(last);
  assert(sub);
  sub.unsubscribe();

  await done;
  sw.mark();
  assert(25 > sw.duration());
  assertEquals(batch.getReceived(), 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch one - breaks after expires", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  await js.publish(subj);

  const sw = time();
  const batch = js.fetch(stream, "me", {
    batch: 10,
    expires: 1000,
  });
  const done = (async () => {
    for await (const m of batch) {
      m.ack();
    }
  })();

  await done;
  sw.mark();
  sw.assertInRange(1000);
  assertEquals(batch.getReceived(), 1);
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer info without pull", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  await js.publish(subj);

  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  const sopts = consumerOpts();
  sopts.durable("me");
  await assertRejects(
    async () => {
      await js.subscribe(subj, sopts);
    },
    Error,
    "push consumer requires deliver_subject",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - autoack", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: createInbox(),
  });

  const js = nc.jetstream();
  await js.publish(subj);

  let ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 1);

  const sopts = consumerOpts();
  sopts.ackAll();
  sopts.durable("me");
  sopts.callback(() => {
    // nothing
  });
  sopts.maxMessages(1);
  const sub = await js.subscribe(subj, sopts);
  await sub.closed;

  await nc.flush();
  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.num_waiting, 0);
  assertEquals(ci.num_ack_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - subscribe - info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.callback(callbackConsume());
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  await delay(250);
  const ci = await sub.consumerInfo();
  assertEquals(ci.delivered.stream_seq, 5);
  assertEquals(ci.ack_floor.stream_seq, 5);
  await sub.destroy();

  await assertRejects(
    async () => {
      await sub.consumerInfo();
    },
    Error,
    "consumer not found",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver new", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.deliverNew();
  opts.maxMessages(1);
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.seq, 6);
    }
  })();
  await js.publish(subj, Empty, { expect: { lastSequence: 5 } });
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver last", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.deliverLast();
  opts.maxMessages(1);
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.seq, 5);
    }
  })();
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - last of", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const jsm = await nc.jetstreamManager();
  const n = nuid.next();
  await jsm.streams.add({
    name: n,
    subjects: [`${n}.>`],
  });

  const subja = `${n}.A`;
  const subjb = `${n}.B`;

  const js = nc.jetstream();

  await js.publish(subja, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subjb, Empty);
  await js.publish(subja, Empty);

  const opts = {
    durable_name: "B",
    filter_subject: subjb,
    deliver_policy: DeliverPolicy.Last,
    ack_policy: AckPolicy.Explicit,
  } as Partial<ConsumerConfig>;

  await jsm.consumers.add(n, opts);
  const m = await js.pull(n, "B");
  assertEquals(m.seq, 3);

  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver seq", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 3 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 4 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.startSequence(2);
  opts.maxMessages(1);
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.seq, 2);
    }
  })();
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver start time", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty, { expect: { lastSequence: 0 } });
  await js.publish(subj, Empty, { expect: { lastSequence: 1 } });

  await delay(1000);
  const now = new Date();
  await js.publish(subj, Empty, { expect: { lastSequence: 2 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.startTime(now);
  opts.maxMessages(1);
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.seq, 3);
    }
  })();
  await done;
  await cleanup(ns, nc);
});

Deno.test("jetstream - deliver last per subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc)) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add(
    { name: stream, subjects: [subj] },
  );

  const js = nc.jetstream();
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 0 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 1 } });
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 2 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 3 } });
  await js.publish(`${stream}.A`, Empty, { expect: { lastSequence: 4 } });
  await js.publish(`${stream}.B`, Empty, { expect: { lastSequence: 5 } });

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.deliverLastPerSubject();
  opts.deliverTo(createInbox());

  const sub = await js.subscribe(subj, opts);
  const ci = await sub.consumerInfo();
  const buf: JsMsg[] = [];
  assertEquals(ci.num_ack_pending, 2);
  const done = (async () => {
    for await (const m of sub) {
      buf.push(m);
      if (buf.length === 2) {
        sub.unsubscribe();
      }
    }
  })();
  await done;
  assertEquals(buf[0].info.streamSequence, 5);
  assertEquals(buf[1].info.streamSequence, 6);
  await cleanup(ns, nc);
});

Deno.test("jetstream - cross account subscribe", async () => {
  const { ns, nc: admin } = await setup(
    jetstreamExportServerConf(),
    {
      user: "js",
      pass: "js",
    },
  );

  // add a stream
  const { subj } = await initStream(admin);
  const adminjs = admin.jetstream();
  await adminjs.publish(subj);
  await adminjs.publish(subj);

  // create a durable config
  const bo = consumerOpts() as ConsumerOptsBuilderImpl;
  bo.durable("me");
  bo.manualAck();
  bo.maxMessages(2);
  bo.deliverTo(createInbox("A"));

  const nc = await connect({
    port: ns.port,
    user: "a",
    pass: "s3cret",
  });
  const js = nc.jetstream({ apiPrefix: "IPA" });

  const opts = bo.getOpts();
  const acks: Promise<boolean>[] = [];
  const d = deferred();
  const sub = await js.subscribe(subj, opts);
  await (async () => {
    for await (const m of sub) {
      acks.push(m.ackAck());
      if (m.seq === 2) {
        d.resolve();
      }
    }
  })();
  await d;
  await Promise.all(acks);
  const ci = await sub.consumerInfo();
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);
  await sub.destroy();
  await assertRejects(
    async () => {
      await sub.consumerInfo();
    },
    Error,
    "consumer not found",
    undefined,
  );

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - cross account pull subscribe", () => {
  disabled("cross account pull subscribe test needs updating");
  // const { ns, nc: admin } = await setup(
  //   jetstreamExportServerConf(),
  //   {
  //     user: "js",
  //     pass: "js",
  //   },
  // );
  //
  // // add a stream
  // const { stream, subj } = await initStream(admin);
  // const adminjs = admin.jetstream();
  // await adminjs.publish(subj);
  // await adminjs.publish(subj);
  //
  // // FIXME: create a durable config
  // const bo = consumerOpts() as ConsumerOptsBuilderImpl;
  // bo.manualAck();
  // bo.ackExplicit();
  // bo.maxMessages(2);
  // bo.durable("me");
  //
  // // pull subscriber stalls
  // const nc = await connect({
  //   port: ns.port,
  //   user: "a",
  //   pass: "s3cret",
  //   inboxPrefix: "A",
  // });
  // const js = nc.jetstream({ apiPrefix: "IPA" });
  //
  // const opts = bo.getOpts();
  // const sub = await js.pullSubscribe(subj, opts);
  // const done = (async () => {
  //   for await (const m of sub) {
  //     m.ack();
  //   }
  // })();
  // sub.pull({ batch: 2 });
  // await done;
  // assertEquals(sub.getProcessed(), 2);
  //
  // const ci = await sub.consumerInfo();
  // assertEquals(ci.num_pending, 0);
  // assertEquals(ci.delivered.stream_seq, 2);
  //
  // await sub.destroy();
  // await assertThrowsAsync(
  //   async () => {
  //     await sub.consumerInfo();
  //   },
  //   Error,
  //   "consumer not found",
  // );
  //
  // await cleanup(ns, admin, nc);
});

Deno.test("jetstream - cross account pull", async () => {
  const { ns, nc: admin } = await setup(
    jetstreamExportServerConf(),
    {
      user: "js",
      pass: "js",
    },
  );

  // add a stream
  const { stream, subj } = await initStream(admin);
  const admjs = admin.jetstream();
  await admjs.publish(subj);
  await admjs.publish(subj);

  const admjsm = await admin.jetstreamManager();

  // create a durable config
  const bo = consumerOpts() as ConsumerOptsBuilderImpl;
  bo.manualAck();
  bo.ackExplicit();
  bo.durable("me");
  const opts = bo.getOpts();
  await admjsm.consumers.add(stream, opts.config);

  const nc = await connect({
    port: ns.port,
    user: "a",
    pass: "s3cret",
    inboxPrefix: "A",
  });

  // the api prefix is not used for pull/fetch()
  const js = nc.jetstream({ apiPrefix: "IPA" });
  let msg = await js.pull(stream, "me");
  assertEquals(msg.seq, 1);
  msg = await js.pull(stream, "me");
  assertEquals(msg.seq, 2);
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    "no messages",
    undefined,
  );

  await cleanup(ns, admin, nc);
});

Deno.test("jetstream - publish headers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();
  const h = headers();
  h.set("a", "b");

  await js.publish(subj, Empty, { headers: h });
  const ms = await js.pull(stream, "me");
  ms.ack();
  assertEquals(ms.headers!.get("a"), "b");
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull stream doesn't exist", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const js = nc.jetstream({ timeout: 1000 });
  await assertRejects(
    async () => {
      await js.pull("helloworld", "me");
    },
    Error,
    ErrorCode.Timeout,
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer doesn't exist", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);
  const js = nc.jetstream({ timeout: 1000 });
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    ErrorCode.Timeout,
    undefined,
  );

  await cleanup(ns, nc);
});

// Deno.test("jetstream - cross account fetch", async () => {
//   const { ns, nc: admin } = await setup(
//     jetstreamExportServerConf(),
//     {
//       user: "js",
//       pass: "js",
//     },
//   );
//
//   // add a stream
//   const { stream, subj } = await initStream(admin);
//   const admjs = admin.jetstream();
//   await admjs.publish(subj, Empty, {msgID: "1"});
//   await admjs.publish(subj, Empty, {msgID: "2"});
//
//   const admjsm = await admin.jetstreamManager();
//
//   // create a durable config
//   const bo = consumerOpts() as ConsumerOptsBuilderImpl;
//   bo.manualAck();
//   bo.ackExplicit();
//   bo.durable("me");
//   bo.maxAckPending(10);
//   const opts = bo.getOpts();
//   await admjsm.consumers.add(stream, opts.config);
//
//   const nc = await connect({
//     port: ns.port,
//     user: "a",
//     pass: "s3cret",
//     inboxPrefix: "A",
//     debug: true,
//   });
//
//   // the api prefix is not used for pull/fetch()
//   const js = nc.jetstream({ apiPrefix: "IPA" });
//   let iter = js.fetch(stream, "me", { batch: 20, expires: 1000 });
//   const msgs = await consume(iter);
//
//   assertEquals(msgs.length, 2);
//
//   // msg = await js.pull(stream, "me");
//   // assertEquals(msg.seq, 2);
//   // await assertThrowsAsync(async () => {
//   //   await js.pull(stream, "me");
//   // }, Error, "No Messages");
//
//   await cleanup(ns, admin, nc);
// });

Deno.test("jetstream - pull consumer doesn't exist", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const { stream } = await initStream(nc);
  const js = nc.jetstream({ timeout: 1000 });
  await assertRejects(
    async () => {
      await js.pull(stream, "me");
    },
    Error,
    ErrorCode.Timeout,
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - ack lease extends with working", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());

  const sn = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: sn, subjects: [`${sn}.>`] });

  const js = nc.jetstream();
  await js.publish(`${sn}.A`, Empty, { msgID: "1" });

  const inbox = createInbox();
  const cc = {
    "ack_wait": nanos(2000),
    "deliver_subject": inbox,
    "ack_policy": AckPolicy.Explicit,
    "durable_name": "me",
  };
  await jsm.consumers.add(sn, cc);

  const opts = consumerOpts();
  opts.durable("me");
  opts.manualAck();

  const sub = await js.subscribe(`${sn}.>`, opts);
  const done = (async () => {
    for await (const m of sub) {
      const timer = setInterval(() => {
        m.working();
      }, 750);
      // we got a message now we are going to delay for 31 sec
      await delay(15);
      const ci = await jsm.consumers.info(sn, "me");
      assertEquals(ci.num_ack_pending, 1);
      m.ack();
      clearInterval(timer);
      break;
    }
  })();

  await done;

  // make sure the message went out
  await nc.flush();
  const ci2 = await jsm.consumers.info(sn, "me");
  assertEquals(ci2.delivered.stream_seq, 1);
  assertEquals(ci2.num_redelivered, 0);
  assertEquals(ci2.num_ack_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - JSON", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jc = JSONCodec();
  const js = nc.jetstream();
  const values = [undefined, null, true, "", ["hello"], { hello: "world" }];
  for (const v of values) {
    await js.publish(subj, jc.encode(v));
  }

  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  for (let v of values) {
    const m = await js.pull(stream, "me");
    m.ack();
    // JSON doesn't serialize undefines, but if passed to the encoder
    // it becomes a null
    if (v === undefined) {
      v = null;
    }
    assertEquals(jc.decode(m.data), v);
  }
  await cleanup(ns, nc);
});

Deno.test("jetstream - qsub", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }
  const { subj } = await initStream(nc);
  const js = nc.jetstream();

  const opts = consumerOpts();
  opts.queue("q");
  opts.durable("n");
  opts.deliverTo("here");
  opts.callback((_err, m) => {
    if (m) {
      m.ack();
    }
  });

  const sub = await js.subscribe(subj, opts);
  const sub2 = await js.subscribe(subj, opts);

  for (let i = 0; i < 100; i++) {
    await js.publish(subj, Empty);
  }
  await nc.flush();
  await sub.drain();
  await sub2.drain();

  assert(sub.getProcessed() > 0);
  assert(sub2.getProcessed() > 0);
  assertEquals(sub.getProcessed() + sub2.getProcessed(), 100);

  await cleanup(ns, nc);
});

Deno.test("jetstream - qsub ackall", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();

  const opts = consumerOpts();
  opts.queue("q");
  opts.durable("n");
  opts.deliverTo("here");
  opts.ackAll();
  opts.callback((_err, _m) => {});

  const sub = await js.subscribe(subj, opts);
  const sub2 = await js.subscribe(subj, opts);

  for (let i = 0; i < 100; i++) {
    await js.publish(subj, Empty);
  }
  await nc.flush();
  await sub.drain();
  await sub2.drain();

  assert(sub.getProcessed() > 0);
  assert(sub2.getProcessed() > 0);
  assertEquals(sub.getProcessed() + sub2.getProcessed(), 100);

  const jsm = await nc.jetstreamManager();
  const ci = await jsm.consumers.info(stream, "n");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.num_ack_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - idle heartbeats", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));

  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();
  await js.publish(subj);
  const jsm = await nc.jetstreamManager();
  const inbox = createInbox();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: inbox,
    idle_heartbeat: nanos(2000),
  });

  const sub = nc.subscribe(inbox, {
    callback: (_err, msg) => {
      if (isHeartbeatMsg(msg)) {
        assertEquals(msg.headers?.get(JsHeaders.LastConsumerSeqHdr), "1");
        assertEquals(msg.headers?.get(JsHeaders.LastStreamSeqHdr), "1");
        sub.drain();
      }
    },
  });

  await sub.closed;
  await cleanup(ns, nc);
});

Deno.test("jetstream - flow control", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({
    jetstream: {
      max_file: -1,
    },
  }, true));
  const { stream, subj } = await initStream(nc);
  const data = new Uint8Array(1024 * 100);
  const js = nc.jetstream();
  const proms = [];
  for (let i = 0; i < 2000; i++) {
    proms.push(js.publish(subj, data));
    nc.publish(subj, data);
    if (proms.length % 100 === 0) {
      await Promise.all(proms);
      proms.length = 0;
    }
  }
  if (proms.length) {
    await Promise.all(proms);
  }
  await nc.flush();

  const jsm = await nc.jetstreamManager();
  const inbox = createInbox();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: inbox,
    flow_control: true,
    idle_heartbeat: nanos(750),
  });

  const fc = deferred();
  const hb = deferred();
  const sub = nc.subscribe(inbox, {
    callback: (_err, msg) => {
      msg.respond();
      if (isFlowControlMsg(msg)) {
        fc.resolve();
      }
      if (isHeartbeatMsg(msg)) {
        hb.resolve();
      }
    },
  });

  await Promise.all([fc, hb]);
  sub.unsubscribe();
  await cleanup(ns, nc);
});

Deno.test("jetstream - domain", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        domain: "afton",
      },
    }, true),
  );

  const jsm = await nc.jetstreamManager({ domain: "afton" });
  const ai = await jsm.getAccountInfo();
  assert(ai.domain, "afton");
  //@ts-ignore: internal use
  assertEquals(jsm.prefix, `$JS.afton.API`);
  await cleanup(ns, nc);
});

Deno.test("jetstream - account domain", async () => {
  const conf = jetstreamServerConf({
    jetstream: {
      domain: "A",
    },
    accounts: {
      A: {
        users: [
          { user: "a", password: "a" },
        ],
        jetstream: { max_memory: 10000, max_file: 10000 },
      },
    },
  }, true);

  const { ns, nc } = await setup(conf, { user: "a", pass: "a" });

  const jsm = await nc.jetstreamManager({ domain: "A" });
  const ai = await jsm.getAccountInfo();
  assert(ai.domain, "A");
  //@ts-ignore: internal use
  assertEquals(jsm.prefix, `$JS.A.API`);
  await cleanup(ns, nc);
});

Deno.test("jetstream - durable resumes", async () => {
  let { ns, nc } = await setup(jetstreamServerConf({}, true), {
    maxReconnectAttempts: -1,
    reconnectTimeWait: 100,
  });

  const { stream, subj } = await initStream(nc);
  const jc = JSONCodec();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  let values = ["a", "b", "c"];
  for (const v of values) {
    await js.publish(subj, jc.encode(v));
  }

  const dsubj = createInbox();
  const opts = consumerOpts();
  opts.ackExplicit();
  opts.deliverAll();
  opts.deliverTo(dsubj);
  opts.durable("me");
  const sub = await js.subscribe(subj, opts);
  const done = (async () => {
    for await (const m of sub) {
      m.ack();
      if (m.seq === 6) {
        sub.unsubscribe();
      }
    }
  })();
  await nc.flush();
  await ns.stop();
  ns = await ns.restart();
  await delay(300);
  values = ["d", "e", "f"];
  for (const v of values) {
    await js.publish(subj, jc.encode(v));
  }
  await nc.flush();
  await done;

  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 6);
  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.delivered.stream_seq, 6);
  assertEquals(ci.num_pending, 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - puback domain", async () => {
  const { ns, nc } = await setup(
    jetstreamServerConf({
      jetstream: {
        domain: "A",
      },
    }, true),
  );

  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }

  const { subj } = await initStream(nc);
  const js = nc.jetstream();
  const pa = await js.publish(subj);
  assertEquals(pa.domain, "A");
  await cleanup(ns, nc);
});

Deno.test("jetstream - cleanup", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);
  const js = nc.jetstream();

  for (let i = 0; i < 100; i++) {
    await js.publish(subj, Empty);
  }

  const opts = consumerOpts();
  opts.deliverTo(createInbox());
  const sub = await js.subscribe(subj, opts);
  let counter = 0;
  const done = (async () => {
    for await (const m of sub) {
      counter++;
      m.ack();
      break;
    }
  })();

  await done;
  assertEquals(counter, 1);
  assertEquals(sub.isClosed(), true);
  const nci = nc as NatsConnectionImpl;
  const min = nci.protocol.subscriptions.getMux() ? 1 : 0;
  assertEquals(nci.protocol.subscriptions.subs.size, min);

  await cleanup(ns, nc);
});

Deno.test("jetstream - reuse consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const id = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    subjects: [`${id}.*`],
    name: id,
    retention: RetentionPolicy.Workqueue,
  });

  await jsm.consumers.add(id, {
    "durable_name": "X",
    "deliver_subject": "out",
    "deliver_policy": DeliverPolicy.All,
    "ack_policy": AckPolicy.Explicit,
    "deliver_group": "queuea",
  });

  // second create should be OK, since it is idempotent
  await jsm.consumers.add(id, {
    "durable_name": "X",
    "deliver_subject": "out",
    "deliver_policy": DeliverPolicy.All,
    "ack_policy": AckPolicy.Explicit,
    "deliver_group": "queuea",
  });

  const js = nc.jetstream();
  const opts = consumerOpts();
  opts.ackExplicit();
  opts.durable("X");
  opts.deliverAll();
  opts.deliverTo("out2");
  opts.queue("queuea");

  const sub = await js.subscribe(`${id}.*`, opts);
  const ci = await sub.consumerInfo();
  // the deliver subject we specified should be ignored
  // the one specified by the consumer is used
  assertEquals(ci.config.deliver_subject, "out");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sub - multiple consumers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const buf: Promise<PubAck>[] = [];
  for (let i = 0; i < 100; i++) {
    buf.push(js.publish(subj, Empty));
  }
  await Promise.all(buf);

  let ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.num_pending, 100);

  let countA = 0;
  let countB = 0;
  const m = new Map<number, number>();

  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.deliverAll();
  const subA = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of subA) {
      const v = m.get(msg.seq) ?? 0;
      m.set(msg.seq, v + 1);
      countA++;
      msg.ack();
    }
  })().then();

  const subB = await js.pullSubscribe(subj, opts);
  (async () => {
    for await (const msg of subB) {
      const v = m.get(msg.seq) ?? 0;
      m.set(msg.seq, v + 1);
      countB++;
      msg.ack();
    }
  })().then();

  const done = deferred<void>();
  const interval = setInterval(() => {
    if (countA + countB < 100) {
      subA.pull({ expires: 500, batch: 25 });
      subB.pull({ expires: 500, batch: 25 });
    } else {
      clearInterval(interval);
      done.resolve();
    }
  }, 25);

  await done;

  ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assert(countA > 0);
  assert(countB > 0);
  assertEquals(countA + countB, 100);

  for (let i = 1; i <= 100; i++) {
    assertEquals(m.get(i), 1);
  }

  await cleanup(ns, nc);
});

Deno.test("jetstream - source", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));

  const stream = nuid.next();
  const subj = `${stream}.*`;
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add(
    { name: stream, subjects: [subj] },
  );

  const js = nc.jetstream();

  for (let i = 0; i < 10; i++) {
    await js.publish(`${stream}.A`);
    await js.publish(`${stream}.B`);
  }

  await jsm.streams.add({
    name: "work",
    storage: StorageType.File,
    retention: RetentionPolicy.Workqueue,
    sources: [
      { name: stream, filter_subject: ">" },
    ],
  });

  // source will not process right away?
  await delay(1000);

  const ci = await jsm.consumers.add("work", {
    ack_policy: AckPolicy.Explicit,
    durable_name: "worker",
    filter_subject: `${stream}.B`,
    deliver_subject: createInbox(),
  });

  const sub = await js.subscribe(`${stream}.B`, { config: ci.config });
  for await (const m of sub) {
    m.ack();
    if (m.info.pending === 0) {
      break;
    }
  }

  // give the server a chance to process the ack's and cleanup
  await nc.flush();

  const si = await jsm.streams.info("work");
  // stream still has all the 'A' messages
  assertEquals(si.state.messages, 10);

  await cleanup(ns, nc);
});

Deno.test("jetstream - nak delay", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.7.1")) {
    return;
  }

  const { subj } = await initStream(nc);
  const js = nc.jetstream();
  await js.publish(subj);

  let start = 0;

  const opts = consumerOpts();
  opts.ackAll();
  opts.deliverTo(createInbox());
  opts.maxMessages(2);
  opts.callback((_, m) => {
    assert(m);
    if (m.redelivered) {
      m.ack();
    } else {
      start = Date.now();
      m.nak(2000);
    }
  });

  const sub = await js.subscribe(subj, opts);
  await sub.closed;

  const delay = Date.now() - start;
  assertBetween(delay, 1800, 2200);
  await cleanup(ns, nc);
});

Deno.test("jetstream - redelivery property works", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.3.5")) {
    return;
  }
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();

  let r = 0;

  const opts = consumerOpts();
  opts.ackAll();
  opts.queue("q");
  opts.durable("n");
  opts.deliverTo(createInbox());
  opts.callback((_err, m) => {
    if (m) {
      if (m.info.redelivered) {
        r++;
      }
      if (m.seq === 100) {
        m.ack();
      }
      if (m.seq % 3 === 0) {
        m.nak();
      }
    }
  });

  const sub = await js.subscribe(subj, opts);
  const sub2 = await js.subscribe(subj, opts);

  for (let i = 0; i < 100; i++) {
    await js.publish(subj, Empty);
  }
  await nc.flush();
  await sub.drain();
  await sub2.drain();

  assert(sub.getProcessed() > 0);
  assert(sub2.getProcessed() > 0);
  assert(r > 0);
  assert(sub.getProcessed() + sub2.getProcessed() > 100);

  await nc.flush();
  const jsm = await nc.jetstreamManager();
  const ci = await jsm.consumers.info(stream, "n");
  assert(ci.delivered.consumer_seq > 100);
  await cleanup(ns, nc);
});

async function ocTest(
  N: number,
  S: number,
  callback: boolean,
): Promise<void> {
  if (N % 10 !== 0) {
    throw new Error("N must be divisible by 10");
  }

  const storage = N * S + (1024 * 1024);
  const { ns, nc } = await setup(jetstreamServerConf({
    jetstream: {
      max_file_store: storage,
    },
  }, true));
  const { subj } = await initStream(nc);
  const js = nc.jetstream();

  const buf = new Uint8Array(S);
  for (let i = 0; i < S; i++) {
    buf[i] = "a".charCodeAt(0) + (i % 26);
  }

  // speed up the loading by sending 10 at time
  const n = N / 10;
  for (let i = 0; i < n; i++) {
    await Promise.all([
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
      js.publish(subj, buf),
    ]);
  }

  const lock = Lock(N, 1000 * 60);
  const opts = consumerOpts({ idle_heartbeat: nanos(1000) });
  opts.orderedConsumer();
  if (callback) {
    opts.callback((err: NatsError | null, msg: JsMsg | null): void => {
      if (err) {
        fail(err.message);
        return;
      }
      if (!msg) {
        fail(`didn't expect to get null msg`);
        return;
      }
      lock.unlock();
    });
  }

  const sub = await js.subscribe(subj, opts);
  if (!callback) {
    (async () => {
      for await (const _jm of sub) {
        lock.unlock();
      }
    })().then();
  }
  await lock;
  //@ts-ignore: test
  assertEquals(sub.sub.info.ordered_consumer_sequence.stream_seq, N);
  //@ts-ignore: test
  assertEquals(sub.sub.info.ordered_consumer_sequence.delivery_seq, N);

  await delay(3 * 1000);
  // @ts-ignore: test
  const hbc = sub.sub.info.flow_control.heartbeat_count;
  assert(hbc >= 2);
  // @ts-ignore: test
  const fcc = sub.sub.info.flow_control.fc_count;
  assert(fcc >= 0);

  // @ts-ignore: test
  assert(sub.sub.info.flow_control.consumer_restarts >= 0);

  // @ts-ignore: test
  assert(sub.sub.info.flow_control.heartbeat_count > 0);

  const ci = await sub.consumerInfo();

  assertEquals(ci.config.deliver_policy, DeliverPolicy.All);
  assertEquals(ci.config.ack_policy, AckPolicy.None);
  assertEquals(ci.config.max_deliver, 1);
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.consumer_seq, N);
  assertEquals(ci.delivered.stream_seq, N);

  await cleanup(ns, nc);
}

Deno.test("jetstream - ordered consumer callback", async () => {
  await ocTest(500, 1024, true);
});

Deno.test("jetstream - ordered consumer iterator", async () => {
  await ocTest(500, 1024, false);
});

Deno.test("jetstream - seal", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(subj, sc.encode("hello"));
  await js.publish(subj, sc.encode("second"));

  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.info(stream);
  assertEquals(si.config.sealed, false);
  assertEquals(si.config.deny_purge, false);
  assertEquals(si.config.deny_delete, false);

  await jsm.streams.deleteMessage(stream, 1);

  si.config.sealed = true;
  const usi = await jsm.streams.update(stream, si.config);
  assertEquals(usi.config.sealed, true);

  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage(stream, 2);
    },
    Error,
    "invalid operation on sealed stream",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - deny delete", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    deny_delete: true,
  });

  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(subj, sc.encode("hello"));
  await js.publish(subj, sc.encode("second"));

  const si = await jsm.streams.info(stream);
  assertEquals(si.config.deny_delete, true);

  await assertRejects(
    async () => {
      await jsm.streams.deleteMessage(stream, 1);
    },
    Error,
    "message delete not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - deny purge", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    deny_purge: true,
  });

  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(subj, sc.encode("hello"));
  await js.publish(subj, sc.encode("second"));

  const si = await jsm.streams.info(stream);
  assertEquals(si.config.deny_purge, true);

  await assertRejects(
    async () => {
      await jsm.streams.purge(stream);
    },
    Error,
    "stream purge not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - rollup all", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: true,
  });

  const js = nc.jetstream();
  const jc = JSONCodec();
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, jc.encode({ value: i })));
  }
  await Promise.all(buf);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueAll);
  await js.publish(`${stream}.summary`, jc.encode({ value: 42 }), {
    headers: h,
  });

  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 1);

  const opts = consumerOpts();
  opts.manualAck();
  opts.deliverTo(createInbox());
  opts.callback((_err, jm) => {
    assert(jm);
    assertEquals(jm.subject, `${stream}.summary`);
    const obj = jc.decode(jm.data) as Record<string, number>;
    assertEquals(obj.value, 42);
  });
  opts.maxMessages(1);

  const sub = await js.subscribe(subj, opts);
  await sub.closed;
  assertEquals(sub.getProcessed(), 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - rollup subject", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = "S";
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: true,
  });

  const js = nc.jetstream();
  const jc = JSONCodec<Record<string, number>>();
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, jc.encode({ value: i })));
    buf.push(js.publish(`${stream}.B`, jc.encode({ value: i })));
  }
  await Promise.all(buf);

  let si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 20);

  let cia = await jsm.consumers.add(stream, {
    durable_name: "dura",
    filter_subject: `${stream}.A`,
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(cia.num_pending, 10);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);
  await js.publish(`${stream}.A`, jc.encode({ value: 0 }), {
    headers: h,
  });

  await delay(5000);

  cia = await jsm.consumers.info(stream, "dura");
  assertEquals(cia.num_pending, 1);

  si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 11);

  const cib = await jsm.consumers.add(stream, {
    durable_name: "durb",
    filter_subject: `${stream}.B`,
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(cib.num_pending, 10);
  await cleanup(ns, nc);
});

Deno.test("jetstream - no rollup", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.3")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = "S";
  const subj = `${stream}.*`;
  const si = await jsm.streams.add({
    name: stream,
    subjects: [subj],
    allow_rollup_hdrs: false,
  });
  assertEquals(si.config.allow_rollup_hdrs, false);

  const js = nc.jetstream();
  const jc = JSONCodec<Record<string, number>>();
  const buf = [];
  for (let i = 1; i < 11; i++) {
    buf.push(js.publish(`${stream}.A`, jc.encode({ value: i })));
  }
  await Promise.all(buf);

  const h = headers();
  h.set(JsHeaders.RollupHdr, JsHeaders.RollupValueSubject);
  await assertRejects(
    async () => {
      await js.publish(`${stream}.A`, jc.encode({ value: 42 }), {
        headers: h,
      });
    },
    Error,
    "rollup not permitted",
    undefined,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - headers only", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
  });

  const js = nc.jetstream();
  const sc = StringCodec();
  await js.publish(`${stream}.A`, sc.encode("a"));
  await js.publish(`${stream}.B`, sc.encode("b"));

  const opts = consumerOpts();
  opts.deliverTo(createInbox());
  opts.headersOnly();
  opts.manualAck();
  opts.callback((_err, jm) => {
    assert(jm);
    assert(jm.headers);
    const size = parseInt(jm.headers.get(JsHeaders.MessageSizeHdr), 10);
    assertEquals(size, 1);
    assertEquals(jm.data, Empty);
    jm.ack();
  });
  opts.maxMessages(2);

  const sub = await js.subscribe(subj, opts);
  await sub.closed;
  assertEquals(sub.getProcessed(), 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - can access kv", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.6.2")) {
    return;
  }
  const sc = StringCodec();

  const js = nc.jetstream();
  // create the named KV or bind to it if it exists:
  const kv = await js.views.kv("testing", { history: 5 });

  // create an entry - this is similar to a put, but will fail if the
  // key exists
  await kv.create("hello.world", sc.encode("hi"));

  // Values in KV are stored as KvEntries:
  // {
  //   bucket: string,
  //   key: string,
  //   value: Uint8Array,
  //   created: Date,
  //   revision: number,
  //   delta?: number,
  //   operation: "PUT"|"DEL"|"PURGE"
  // }
  // The operation property specifies whether the value was
  // updated (PUT), deleted (DEL) or purged (PURGE).

  // you can monitor values modification in a KV by watching.
  // You can watch specific key subset or everything.
  // Watches start with the latest value for each key in the
  // set of keys being watched - in this case all keys
  const watch = await kv.watch();
  (async () => {
    for await (const _e of watch) {
      // do something with the change
    }
  })().then();

  // update the entry
  await kv.put("hello.world", sc.encode("world"));
  // retrieve the KvEntry storing the value
  // returns null if the value is not found
  const e = await kv.get("hello.world");
  assert(e);
  // initial value of "hi" was overwritten above
  assertEquals(sc.decode(e.value), "world");

  const keys = await collect<string>(await kv.keys());
  assertEquals(keys.length, 1);
  assertEquals(keys[0], "hello.world");

  const h = await kv.history({ key: "hello.world" });
  (async () => {
    for await (const _e of h) {
      // do something with the historical value
      // you can test e.operation for "PUT", "DEL", or "PURGE"
      // to know if the entry is a marker for a value set
      // or for a deletion or purge.
    }
  })().then();

  // deletes the key - the delete is recorded
  await kv.delete("hello.world");

  // purge is like delete, but all history values
  // are dropped and only the purge remains.
  await kv.purge("hello.world");

  // stop the watch operation above
  watch.stop();

  // danger: destroys all values in the KV!
  await kv.destroy();

  await cleanup(ns, nc);
});

Deno.test("jetstream - bind", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
  });

  const inbox = createInbox();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.None,
    deliver_subject: inbox,
  });

  const opts = consumerOpts();
  opts.bind(stream, "hello");
  opts.deliverTo(inbox);

  await assertRejects(
    async () => {
      await js.subscribe(subj, opts);
    },
    Error,
    `unable to bind - durable consumer hello doesn't exist in ${stream}`,
    undefined,
  );
  // the rejection happens and the unsub is scheduled, but it is possible that
  // the server didn't process it yet - flush to make sure the unsub was seen
  await nc.flush();

  opts.bind(stream, "me");
  const sub = await js.subscribe(subj, opts);
  assertEquals(sub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - bind with diff subject fails", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const jsm = await nc.jetstreamManager();
  const stream = nuid.next();
  const subj = `${stream}.*`;
  await jsm.streams.add({
    name: stream,
    subjects: [subj],
  });

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.None,
    deliver_subject: createInbox(),
    filter_subject: `${stream}.foo`,
  });

  const opts = consumerOpts();
  opts.bind(stream, "me");
  opts.filterSubject(`${stream}.bar`);
  await assertRejects(
    async () => {
      const js = nc.jetstream();
      await js.subscribe(subj, opts);
    },
    Error,
    "subject does not match consumer",
    undefined,
  );
  await cleanup(ns, nc);
});

Deno.test("jetstream - bind example", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  const subj = `A.*`;
  await jsm.streams.add({
    name: "A",
    subjects: [subj],
  });

  const inbox = createInbox();
  await jsm.consumers.add("A", {
    durable_name: "me",
    ack_policy: AckPolicy.None,
    deliver_subject: inbox,
  });

  const opts = consumerOpts();
  opts.bind("A", "me");

  const sub = await js.subscribe(subj, opts);
  assertEquals(sub.getProcessed(), 0);

  await cleanup(ns, nc);
});

Deno.test("jetstream - test events stream", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name: "events",
    subjects: ["events.>"],
  });

  await js.subscribe("events.>", {
    stream: "events",
    config: {
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      deliver_subject: "foo",
      durable_name: "me",
      filter_subject: "events.>",
    },
    callbackFn: (_err: NatsError | null, msg: JsMsg | null) => {
      msg?.ack();
    },
  });

  await js.publish("events.a");
  await js.publish("events.b");
  await delay(2000);
  await cleanup(ns, nc);
});

Deno.test("jetstream - bind without consumer should fail", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name: "events",
    subjects: ["events.>"],
  });

  const opts = consumerOpts();
  opts.manualAck();
  opts.ackExplicit();
  opts.bind("events", "hello");

  await assertRejects(
    async () => {
      await js.subscribe("events.>", opts);
    },
    Error,
    "unable to bind - durable consumer hello doesn't exist in events",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull next", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj);
  await js.publish(subj);

  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.info(stream);
  assertEquals(si.state.messages, 2);

  let inbox = "";
  const opts = consumerOpts();
  opts.durable("me");
  opts.ackExplicit();
  opts.manualAck();
  opts.callback((err, msg) => {
    if (err) {
      if (err.code === ErrorCode.JetStream408RequestTimeout) {
        sub.unsubscribe();
        return;
      } else {
        fail(err.message);
      }
    }
    if (msg) {
      msg.next(inbox, { batch: 1, expires: 250 });
    }
  });
  const sub = await js.pullSubscribe(subj, opts);
  inbox = sub.getSubject();
  sub.pull({ batch: 1, expires: 1000 });

  await sub.closed;

  const subin = sub as unknown as JetStreamSubscriptionInfoable;
  assert(subin.info);
  assertEquals(subin.info.attached, false);
  await sub.closed;

  const ci = await jsm.consumers.info(stream, "me");
  assertEquals(ci.num_pending, 0);
  assertEquals(ci.delivered.stream_seq, 2);
  assertEquals(ci.ack_floor.stream_seq, 2);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull errors", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));

  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });
  const js = nc.jetstream();

  async function expectError(
    expires: number,
    code: ErrorCode,
  ) {
    try {
      await js.pull(stream, "me", expires);
    } catch (err) {
      assertEquals(err.code, code);
    }
  }

  await expectError(0, ErrorCode.JetStream404NoMessages);
  await expectError(1000, ErrorCode.JetStream408RequestTimeout);

  await js.publish(subj);

  // we expect a message
  const a = await js.pull(stream, "me", 1000);
  assertEquals(a.seq, 1);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull error: max_waiting", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.8.2")) {
    return;
  }

  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_waiting: 1,
  });
  const js = nc.jetstream();

  async function expectError(
    expires: number,
    code: ErrorCode,
  ): Promise<NatsError> {
    const d = deferred<NatsError>();
    try {
      await js.pull(stream, "me", expires);
    } catch (err) {
      d.resolve(err);
      assertEquals(err.code, code);
    }
    return d;
  }
  await Promise.all([
    expectError(
      3000,
      ErrorCode.JetStream408RequestTimeout,
    ),
    expectError(3000, ErrorCode.JetStream409),
  ]);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull error: js not enabled", async () => {
  const { ns, nc } = await setup();
  const js = nc.jetstream();
  async function expectError(code: ErrorCode, expires: number) {
    const noMsgs = deferred<NatsError>();
    try {
      await js.pull("stream", "me", expires);
    } catch (err) {
      noMsgs.resolve(err);
    }
    const ne = await noMsgs;
    assertEquals(ne.code, code);
  }

  await expectError(ErrorCode.JetStreamNotEnabled, 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - mirror alternates", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });
  if (await notCompatible(servers[0], nc, "2.8.2")) {
    await NatsServer.stopAll([servers[1], servers[2]]);
    return;
  }

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "src", subjects: ["A", "B"] });

  const nc1 = await connect({ port: servers[1].port });
  const jsm1 = await nc1.jetstreamManager();

  await jsm1.streams.add({
    name: "mirror",
    mirror: {
      name: "src",
    },
  });

  const n = await jsm1.streams.find("A");
  const si = await jsm1.streams.info(n);
  assertEquals(si.alternates?.length, 2);

  await nc.close();
  await nc1.close();
  await NatsServer.stopAll(servers);
});

Deno.test("jetstream - backoff", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.7.2")) {
    return;
  }

  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  const backoff = [nanos(250), nanos(1000), nanos(3000)];
  const ci = await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    max_deliver: 4,
    deliver_subject: "here",
    backoff,
  });

  assert(ci.config.backoff);
  assertEquals(ci.config.backoff[0], backoff[0]);
  assertEquals(ci.config.backoff[1], backoff[1]);
  assertEquals(ci.config.backoff[2], backoff[2]);

  const js = nc.jetstream();
  await js.publish(subj);

  const opts = consumerOpts();
  opts.bind(stream, "me");
  opts.manualAck();

  const arrive: number[] = [];
  let start = 0;
  const sub = await js.subscribe(subj, opts);
  await (async () => {
    for await (const m of sub) {
      if (start === 0) {
        start = Date.now();
      }
      arrive.push(Date.now());
      if (m.info.redeliveryCount === 4) {
        break;
      }
    }
  })();

  const delta = arrive.map((v) => {
    return v - start;
  });

  assert(delta[1] > 250 && delta[1] < 1000);
  assert(delta[2] > 1250 && delta[2] < 1500);
  assert(delta[3] > 4250 && delta[2] < 4500);

  await cleanup(ns, nc);
});

Deno.test("jetstream - push bound", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    deliver_subject: "here",
  });

  const opts = consumerOpts();
  opts.durable("me");
  opts.manualAck();
  opts.ackExplicit();
  opts.deliverTo("here");
  opts.callback((_err, msg) => {
    if (msg) {
      msg.ack();
    }
  });
  const js = nc.jetstream();
  await js.subscribe(subj, opts);

  const nc2 = await connect({ port: ns.port });
  const js2 = nc2.jetstream();
  await assertRejects(
    async () => {
      await js2.subscribe(subj, opts);
    },
    Error,
    "duplicate subscription",
  );

  await cleanup(ns, nc, nc2);
});

Deno.test("jetstream - detailed errors", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const jsm = await nc.jetstreamManager();

  const ne = await assertRejects(() => {
    return jsm.streams.add({
      name: "test",
      num_replicas: 3,
      subjects: ["foo"],
    });
  }) as NatsError;

  assert(ne.api_error);
  assertEquals(
    ne.message,
    "replicas > 1 not supported in non-clustered mode",
  );
  assertEquals(
    ne.api_error.description,
    "replicas > 1 not supported in non-clustered mode",
  );
  assertEquals(ne.api_error.code, 500);
  assertEquals(ne.api_error.err_code, 10074);

  await cleanup(ns, nc);
});

Deno.test("jetstream - ephemeral pull consumer", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const d = deferred<JsMsg>();
  const js = nc.jetstream();

  // no durable name specified
  const opts = consumerOpts();
  opts.manualAck();
  opts.ackExplicit();
  opts.deliverAll();
  opts.inactiveEphemeralThreshold(500);
  opts.callback((_err, msg) => {
    assert(msg !== null);
    d.resolve(msg);
  });

  const sub = await js.pullSubscribe(subj, opts);
  const old = await sub.consumerInfo();

  const sc = StringCodec();
  await js.publish(subj, sc.encode("hello"));
  sub.pull({ batch: 1, expires: 1000 });

  const m = await d;
  assertEquals(sc.decode(m.data), "hello");

  sub.unsubscribe();
  await nc.flush();

  const jsm = await nc.jetstreamManager();
  await delay(1500);
  await assertRejects(
    async () => {
      await jsm.consumers.info(stream, old.name);
    },
    Error,
    "consumer not found",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer max_bytes rejected on old servers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  // change the version of the server to fail pull with max bytes
  const nci = nc as NatsConnectionImpl;
  nci.features.update("2.7.0");

  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
    filter_subject: ">",
  });
  const js = nc.jetstream() as JetStreamClientImpl;

  const d = deferred<NatsError>();

  const opts = consumerOpts();
  opts.deliverAll();
  opts.ackExplicit();
  opts.manualAck();
  opts.callback((err, _msg) => {
    if (err) {
      d.resolve(err);
    }
  });

  const sub = await js.pullSubscribe(subj, opts);
  assertThrows(
    () => {
      sub.pull({ expires: 2000, max_bytes: 2 });
    },
    Error,
    "max_bytes is only supported on servers 2.8.3 or better",
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeat missed on fetch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const iter = js.fetch(stream, "me", {
    expires: 2000,
    idle_heartbeat: 250,
    //@ts-ignore: testing
    delay_heartbeat: true,
  });

  await assertRejects(
    async () => {
      for await (const _m of iter) {
        // no message expected
      }
    },
    NatsError,
    Js409Errors.IdleHeartbeatMissed,
  );

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeat on fetch", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream } = await initStream(nc);
  const jsm = await nc.jetstreamManager();

  await jsm.consumers.add(stream, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  const iter = js.fetch(stream, "me", {
    expires: 2000,
    idle_heartbeat: 250,
  });

  // we don't expect this to throw
  await (async () => {
    for await (const _m of iter) {
      // no message expected
    }
  })();

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeats errors repeat in callback push sub", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const js = nc.jetstream();
  await js.publish(subj, Empty);

  const buf: NatsError[] = [];

  const d = deferred<void>();
  const fn = (err: NatsError | null, _msg: JsMsg | null): void => {
    if (err) {
      buf.push(err);
      if (buf.length === 3) {
        d.resolve();
      }
    }
  };

  const opts = consumerOpts();
  opts.durable("me");
  opts.manualAck();
  opts.ackExplicit();
  opts.idleHeartbeat(800);
  opts.deliverTo(createInbox());
  opts.callback(fn);

  const sub = await js.subscribe(subj, opts) as JetStreamSubscriptionImpl;
  assert(sub.monitor);
  await delay(3000);
  sub.monitor._change(100, 0, 3);

  buf.forEach((err) => {
    assertIsError(err, NatsError, Js409Errors.IdleHeartbeatMissed);
  });

  assertEquals(sub.sub.isClosed(), false);

  await cleanup(ns, nc);
});

Deno.test("jetstream - idleheartbeats errors in iterator push sub", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);

  const opts = consumerOpts();
  opts.durable("me");
  opts.manualAck();
  opts.ackExplicit();
  opts.idleHeartbeat(800);
  opts.deliverTo(createInbox());

  const js = nc.jetstream();
  const sub = await js.subscribe(subj, opts) as JetStreamSubscriptionImpl;

  const d = deferred<NatsError>();
  (async () => {
    for await (const _m of sub) {
      // not going to get anything
    }
  })().catch((err) => {
    d.resolve(err);
  });
  assert(sub.monitor);
  await delay(1700);
  sub.monitor._change(100, 0, 1);
  const err = await d;
  assertIsError(err, NatsError, Js409Errors.IdleHeartbeatMissed);
  assertEquals(err.code, ErrorCode.JetStreamIdleHeartBeat);
  assertEquals(sub.sub.isClosed(), true);

  await cleanup(ns, nc);
});

Deno.test("jetstream - bind ephemeral can get consumer info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);

  const jsm = await nc.jetstreamManager();

  async function testEphemeral(deliverSubject = ""): Promise<void> {
    const ci = await jsm.consumers.add(stream, {
      ack_policy: AckPolicy.Explicit,
      inactive_threshold: nanos(5000),
      deliver_subject: deliverSubject,
    });

    const js = nc.jetstream();
    const opts = consumerOpts();
    opts.bind(stream, ci.name);
    const sub = deliverSubject
      ? await js.subscribe(subj, opts)
      : await js.pullSubscribe(subj, opts);
    const sci = await sub.consumerInfo();
    assertEquals(
      sci.name,
      ci.name,
      `failed getting ci for ${deliverSubject ? "push" : "pull"}`,
    );
  }

  await testEphemeral();
  await testEphemeral(createInbox());

  await cleanup(ns, nc);
});

Deno.test("jetstream - create ephemeral with config can get consumer info", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { stream, subj } = await initStream(nc);
  const js = nc.jetstream();

  async function testEphemeral(deliverSubject = ""): Promise<void> {
    const opts = {
      stream,
      config: {
        ack_policy: AckPolicy.Explicit,
        deliver_subject: deliverSubject,
      },
    };
    const sub = deliverSubject
      ? await js.subscribe(subj, opts)
      : await js.pullSubscribe(subj, opts);
    const ci = await sub.consumerInfo();
    assert(
      ci.name,
      `failed getting name for ${deliverSubject ? "push" : "pull"}`,
    );
    assert(
      !ci.config.durable_name,
      `unexpected durable name for ${deliverSubject ? "push" : "pull"}`,
    );
  }

  await testEphemeral();
  await testEphemeral(createInbox());

  await cleanup(ns, nc);
});

Deno.test("jetstream - repub on 503", async () => {
  let servers = await NatsServer.jetstreamCluster(4, {});
  servers[0].config.jetstream = "disabled";
  await NatsServer.stopAll(servers);
  const proms = servers.map((s) => {
    return s.restart();
  });

  const connection = await proms[0];
  const data = await NatsServer.dataClusterFormed([
    proms[1],
    proms[2],
    proms[3],
  ]);
  servers = [connection, data[0], data[1], data[2]];

  const nc = await connect({ port: connection.port });

  const { stream, subj } = await initStream(nc, nuid.next(), {
    num_replicas: 3,
  });

  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.info(stream);
  const host = si.cluster!.leader || "";
  const leader = servers.find((s) => {
    return s.config.server_name === host;
  });

  // publish a message
  const js = nc.jetstream();
  const pa = await js.publish(subj);
  assertEquals(pa.stream, stream);

  // now stop and wait a bit for the servers
  await leader?.stop();
  await delay(1000);

  await js.publish(subj, Empty, {
    //@ts-ignore: testing
    retries: 15,
    retry_delay: 1000,
    timeout: 15000,
  });

  await nc.close();
  await NatsServer.stopAll(servers);
});

Deno.test("jetstream - duplicate message pub", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  const { subj } = await initStream(nc);
  const js = nc.jetstream();

  let ack = await js.publish(subj, Empty, { msgID: "x" });
  assertEquals(ack.duplicate, false);

  ack = await js.publish(subj, Empty, { msgID: "x" });
  assertEquals(ack.duplicate, true);

  await cleanup(ns, nc);
});

Deno.test("jetstream - republish", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.add({
    name: nuid.next(),
    subjects: ["foo"],
    republish: {
      src: "foo",
      dest: "bar",
    },
  });

  assertEquals(si.config.republish?.src, "foo");
  assertEquals(si.config.republish?.dest, "bar");

  const sub = nc.subscribe("bar", { max: 1 });
  const done = (async () => {
    for await (const m of sub) {
      assertEquals(m.subject, "bar");
      assert(m.headers?.get(RepublishHeaders.Subject), "foo");
      assert(m.headers?.get(RepublishHeaders.Sequence), "1");
      assert(m.headers?.get(RepublishHeaders.Stream), si.config.name);
      assert(m.headers?.get(RepublishHeaders.LastSequence), "0");
    }
  })();

  nc.publish("foo");
  await done;

  await cleanup(ns, nc);
});

Deno.test("jetstream - mem_storage consumer option", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const { stream, subj } = await initStream(nc);
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.info(stream);
  assertEquals(si.config.storage, StorageType.File);

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.durable("opts");
  opts.memory();

  const js = nc.jetstream();
  const sub = await js.pullSubscribe(subj, opts);
  let ci = await sub.consumerInfo();
  assertEquals(ci.config.mem_storage, true);

  ci.config.mem_storage = false;
  ci = await jsm.consumers.update(stream, "opts", ci.config);
  assertEquals(ci.config.mem_storage, undefined);

  ci = await jsm.consumers.add(stream, {
    durable_name: "dopts",
    mem_storage: true,
    ack_policy: AckPolicy.Explicit,
  });
  assertEquals(ci.config.mem_storage, true);

  await cleanup(ns, nc);
});

Deno.test("jetstream - num_replicas consumer option", async () => {
  const servers = await NatsServer.jetstreamCluster(3);
  const nc = await connect({ port: servers[0].port });
  if (await notCompatible(servers[0], nc, "2.9.0")) {
    await NatsServer.stopAll(servers);
    return;
  }

  const { stream, subj } = await initStream(nc, nuid.next(), {
    num_replicas: 3,
  });
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.info(stream);
  assertEquals(si.config.num_replicas, 3);

  const opts = consumerOpts();
  opts.ackExplicit();
  opts.durable("opts");

  const js = nc.jetstream();
  const sub = await js.pullSubscribe(subj, opts);
  let ci = await sub.consumerInfo();
  assertEquals(ci.config.num_replicas, 0);

  ci.config.num_replicas = 2;
  ci = await jsm.consumers.update(stream, "opts", ci.config);
  assertEquals(ci.config.num_replicas, 2);

  await nc.close();
  await NatsServer.stopAll(servers);
  // in ci this hangs
  await delay(500);
});

Deno.test("jetstream - filter_subject consumer update", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({}, true));
  if (await notCompatible(ns, nc, "2.9.0")) {
    return;
  }

  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["foo.>"] });
  let ci = await jsm.consumers.add(si.config.name, {
    ack_policy: AckPolicy.Explicit,
    filter_subject: "foo.bar",
    durable_name: "a",
  });
  assertEquals(ci.config.filter_subject, "foo.bar");

  ci.config.filter_subject = "foo.baz";
  ci = await jsm.consumers.update(si.config.name, "a", ci.config);
  assertEquals(ci.config.filter_subject, "foo.baz");
  await cleanup(ns, nc);
});

Deno.test("jetstream - kv and object store views reject in older servers", async () => {
  const { ns, nc } = await setup(jetstreamServerConf({
    max_payload: 1024 * 1024,
  }, true));

  const nci = nc as NatsConnectionImpl;
  const js = nc.jetstream();
  async function t(version: string, kv: boolean, os: boolean): Promise<void> {
    nci.features.update(version);

    if (!kv) {
      await assertRejects(
        async () => {
          await js.views.kv(nuid.next());
        },
        Error,
        `kv is only supported on servers 2.6.2 or better`,
      );
    } else {
      await js.views.kv(nuid.next());
    }

    if (!os) {
      await assertRejects(
        async () => {
          await js.views.os(nuid.next());
        },
        Error,
        `objectstore is only supported on servers 2.6.3 or better`,
      );
    } else {
      await js.views.os(nuid.next());
    }
  }

  await t("2.6.1", false, false);
  await t("2.6.2", true, false);
  await t("2.6.3", true, true);
  await t("2.6.4", true, true);

  await cleanup(ns, nc);
});

Deno.test("jetstream - ordered consumer reset", async () => {
  let { ns, nc } = await setup(jetstreamServerConf({}));
  const { subj } = await initStream(nc, "A");
  const d = deferred<JsMsg>();
  const js = nc.jetstream();
  const opts = consumerOpts();
  opts.orderedConsumer();
  opts.callback((err, m) => {
    if (err) {
      fail(err.message);
    }
    c.unsubscribe();
    d.resolve(m!);
  });
  const c = await js.subscribe(subj, opts);

  // stop the server and wait until hbs are missed
  await ns.stop();
  while (true) {
    const missed = (c as JetStreamSubscriptionImpl).monitor?.missed || 0;
    const connected = (nc as NatsConnectionImpl).protocol.connected;
    // we want to wait until after 2 because we want to have a cycle
    // where we try to recreate the consumer, but skip it because we are
    // not connected
    if (!connected && missed >= 3) {
      break;
    }
    await delay(300);
  }
  ns = await ns.restart();
  let ack: PubAck;
  while (true) {
    try {
      ack = await js.publish(subj);
      break;
    } catch (err) {
      if (err.code !== ErrorCode.Timeout) {
        fail(err.message);
      }
      await delay(1000);
    }
  }
  await c.closed;

  assertEquals((await d).seq, ack.seq);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch on stopped server doesn't close client", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });
  (async () => {
    let reconnects = 0;
    for await (const s of nc.status()) {
      switch (s.type) {
        case DebugEvents.Reconnecting:
          reconnects++;
          if (reconnects === 2) {
            ns.restart().then((s) => {
              ns = s;
            });
          }
          break;
        case Events.Reconnect:
          setTimeout(() => {
            loop = false;
          });
          break;
        default:
          // nothing
      }
    }
  })().then();
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["test"] });
  const { name: stream } = si.config;
  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();

  setTimeout(() => {
    ns.stop();
  }, 2000);

  let loop = true;
  while (true) {
    try {
      const iter = js.fetch(stream, "dur", { batch: 1, expires: 500 });
      for await (const m of iter) {
        m.ack();
      }
      if (!loop) {
        break;
      }
    } catch (err) {
      fail(`shouldn't have errored: ${err.message}`);
    }
  }
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull on stopped server doesn't close client", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });
  (async () => {
    let reconnects = 0;
    for await (const s of nc.status()) {
      switch (s.type) {
        case DebugEvents.Reconnecting:
          reconnects++;
          if (reconnects === 2) {
            ns.restart().then((s) => {
              ns = s;
            });
          }
          break;
        case Events.Reconnect:
          setTimeout(() => {
            loop = false;
          });
          break;
        default:
          // nothing
      }
    }
  })().then();
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["test"] });
  const { name: stream } = si.config;
  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();
  setTimeout(() => {
    ns.stop();
  }, 2000);

  let loop = true;
  let requestTimeouts = 0;
  while (true) {
    try {
      await js.pull(stream, "dur", 500);
    } catch (err) {
      switch (err.code) {
        case ErrorCode.Timeout:
          // js is not ready
          continue;
        case ErrorCode.JetStream408RequestTimeout:
          requestTimeouts++;
          break;
        default:
          fail(`unexpected error: ${err.message}`);
          break;
      }
    }
    if (!loop) {
      break;
    }
  }
  assert(requestTimeouts > 0);
  await cleanup(ns, nc);
});

Deno.test("jetstream - push on stopped server doesn't close client", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });
  const reconnected = deferred<void>();
  (async () => {
    let reconnects = 0;
    for await (const s of nc.status()) {
      switch (s.type) {
        case DebugEvents.Reconnecting:
          reconnects++;
          if (reconnects === 2) {
            ns.restart().then((s) => {
              ns = s;
            });
          }
          break;
        case Events.Reconnect:
          setTimeout(() => {
            reconnected.resolve();
          }, 1000);
          break;
        default:
          // nothing
      }
    }
  })().then();
  const jsm = await nc.jetstreamManager();
  const si = await jsm.streams.add({ name: nuid.next(), subjects: ["test"] });
  const { name: stream } = si.config;

  const js = nc.jetstream();

  await jsm.consumers.add(stream, {
    durable_name: "dur",
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "bar",
  });

  const opts = consumerOpts().manualAck().deliverTo(nuid.next());
  const sub = await js.subscribe("test", opts);
  (async () => {
    for await (const m of sub) {
      m.ack();
    }
  })().then();

  setTimeout(() => {
    ns.stop();
  }, 2000);

  await reconnected;
  assertEquals(nc.isClosed(), false);
  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch heartbeat", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const d = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        d.resolve();
      }
    }
  })().then();

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });
  const js = nc.jetstream();
  await ns.stop();

  const iter = js.fetch("my-stream", "dur", {
    batch: 1,
    expires: 5000,
    idle_heartbeat: 500,
  });

  await assertRejects(
    async () => {
      for await (const m of iter) {
        m.ack();
      }
    },
    Error,
    "idle heartbeats missed",
  );
  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await d;
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull heartbeat", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = nc.jetstream();

  const d = deferred();
  const opts = consumerOpts().ackExplicit().callback((err, m) => {
    if (err?.code === ErrorCode.JetStreamIdleHeartBeat) {
      d.resolve();
    }
    if (m) {
      m.ack();
    }
  });
  const psub = await js.pullSubscribe("test", opts);
  await ns.stop();

  psub.pull({ idle_heartbeat: 500, expires: 5000, batch: 1 });
  await d;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - pull heartbeat iter", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = nc.jetstream();

  const opts = consumerOpts().ackExplicit();
  const psub = await js.pullSubscribe("test", opts);
  const done = assertRejects(
    async () => {
      for await (const m of psub) {
        m.ack();
      }
    },
    Error,
    "idle heartbeats missed",
  );

  await ns.stop();
  psub.pull({ idle_heartbeat: 500, expires: 5000, batch: 1 });
  await done;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - push heartbeat iter", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = nc.jetstream();

  const opts = consumerOpts({ idle_heartbeat: nanos(500) }).ackExplicit()
    .deliverTo(nuid.next());
  const psub = await js.subscribe("test", opts);
  const done = assertRejects(
    async () => {
      for await (const m of psub) {
        m.ack();
      }
    },
    Error,
    "idle heartbeats missed",
  );

  await ns.stop();
  await done;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - push heartbeat callback", async () => {
  let { ns, nc } = await setup(jetstreamServerConf(), {
    maxReconnectAttempts: -1,
  });

  const reconnected = deferred();
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === Events.Reconnect) {
        // if we reconnect, close the client
        reconnected.resolve();
      }
    }
  })().then();

  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({ name: "my-stream", subjects: ["test"] });

  const js = nc.jetstream();
  const d = deferred();
  const opts = consumerOpts({ idle_heartbeat: nanos(500) }).ackExplicit()
    .deliverTo(nuid.next())
    .callback((err, m) => {
      if (err?.code === ErrorCode.JetStreamIdleHeartBeat) {
        d.resolve();
      }
      if (m) {
        m.ack();
      }
    });
  await js.subscribe("test", opts);
  await ns.stop();
  await d;

  ns = await ns.restart();
  // this here because otherwise get a resource leak error in the test
  await reconnected;
  await cleanup(ns, nc);
});

Deno.test("jetstream - consumer opt multi subject filter", () => {
  const opts = new ConsumerOptsBuilderImpl();
  opts.filterSubject("foo");
  let co = opts.getOpts();
  assertEquals(co.config.filter_subject, "foo");

  opts.filterSubject("bar");
  co = opts.getOpts();
  assertEquals(co.config.filter_subject, undefined);
  assertExists(co.config.filter_subjects);
  assertArrayIncludes(co.config.filter_subjects, ["foo", "bar"]);
});

Deno.test("jetstream - push multi-subject filter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .filterSubject("a.c")
    .deliverTo(createInbox())
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.subscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertExists(ci.config.filter_subjects);
  assertArrayIncludes(ci.config.filter_subjects, ["a.b", "a.c"]);

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull multi-subject filter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .filterSubject("a.c")
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.pullSubscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertExists(ci.config.filter_subjects);
  assertArrayIncludes(ci.config.filter_subjects, ["a.b", "a.c"]);

  await cleanup(ns, nc);
});

Deno.test("jetstream - push single filter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .deliverTo(createInbox())
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.subscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertEquals(ci.config.filter_subject, "a.b");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull single filter", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  const opts = consumerOpts()
    .durable("me")
    .ackExplicit()
    .filterSubject("a.b")
    .callback((_err, msg) => {
      msg?.ack();
    });

  const sub = await js.pullSubscribe("a.>", opts);
  const ci = await sub.consumerInfo();
  assertEquals(ci.config.filter_subject, "a.b");

  await cleanup(ns, nc);
});

Deno.test("jetstream - jsmsg decode", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  await jsm.streams.add({ name, subjects: [`a.>`] });

  await jsm.consumers.add(name, {
    durable_name: "me",
    ack_policy: AckPolicy.Explicit,
  });

  await js.publish("a.a", StringCodec().encode("hello"));
  await js.publish("a.a", JSONCodec().encode({ one: "two", a: [1, 2, 3] }));

  assertEquals((await js.pull(name, "me")).string(), "hello");
  assertEquals((await js.pull(name, "me")).json(), {
    one: "two",
    a: [1, 2, 3],
  });

  await cleanup(ns, nc);
});

Deno.test("jetstream - input transform", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.0")) {
    return;
  }
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();

  const si = await jsm.streams.add({
    name,
    subjects: ["foo"],
    subject_transform: {
      src: ">",
      dest: "transformed.>",
    },
    storage: StorageType.Memory,
  });

  assertEquals(si.config.subject_transform, {
    src: ">",
    dest: "transformed.>",
  });

  const js = nc.jetstream();
  const pa = await js.publish("foo", Empty);
  assertEquals(pa.seq, 1);

  const m = await jsm.streams.getMessage(si.config.name, { seq: 1 });
  assertEquals(m.subject, "transformed.foo");

  await cleanup(ns, nc);
});

Deno.test("jetstream - source transforms", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  if (await notCompatible(ns, nc, "2.10.2")) {
    return;
  }
  const jsm = await nc.jetstreamManager();

  const proms = ["foo", "bar", "baz"].map((subj) => {
    return jsm.streams.add({
      name: subj,
      subjects: [subj],
      storage: StorageType.Memory,
    });
  });
  await Promise.all(proms);

  const js = nc.jetstream();
  await Promise.all([
    js.publish("foo", Empty),
    js.publish("bar", Empty),
    js.publish("baz", Empty),
  ]);

  await jsm.streams.add({
    name: "sourced",
    storage: StorageType.Memory,
    sources: [
      { name: "foo", subject_transforms: [{ src: ">", dest: "foo2.>" }] },
      { name: "bar" },
      { name: "baz" },
    ],
  });

  while (true) {
    const si = await jsm.streams.info("sourced");
    if (si.state.messages === 3) {
      break;
    }
    await delay(100);
  }

  const m = await jsm.streams.getMessage("sourced", { seq: 1 });
  assertEquals(m.subject, "foo2.foo");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull consumer deleted", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = nc.jetstream();

  js.pull(name, name, 5000)
    .catch((err) => {
      d.resolve(err);
    });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch consumer deleted", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = nc.jetstream();

  const iter = js.fetch(name, name, { expires: 5000 });
  (async () => {
    for await (const _m of iter) {
      // nothing
    }
  })().catch((err) => {
    d.resolve(err);
  });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pullSub cb consumer deleted", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = nc.jetstream();

  const opts = consumerOpts().bind(name, name).callback((err, _m) => {
    if (err) {
      d.resolve(err);
    }
  });
  const sub = await js.pullSubscribe(name, opts);
  sub.pull({ expires: 5000 });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - pullSub iter consumer deleted", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const d = deferred<NatsError>();
  const js = nc.jetstream();

  const opts = consumerOpts().bind(name, name);

  const sub = await js.pullSubscribe(name, opts);
  (async () => {
    for await (const _m of sub) {
      // nothing
    }
  })().catch((err) => {
    d.resolve(err);
  });
  sub.pull({ expires: 5000 });
  await nc.flush();
  await jsm.consumers.delete(name, name);

  const err = await d;
  assertEquals(err?.message, "consumer deleted");

  await cleanup(ns, nc);
});

Deno.test("jetstream - fetch sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();

  await js.publish(name);
  await js.publish(name);

  const iter = js.fetch(name, name, { batch: 2, no_wait: true });
  const sync = syncIterator(iter);
  assertExists(await sync.next());
  assertExists(await sync.next());
  assertEquals(await sync.next(), null);

  await cleanup(ns, nc);
});

Deno.test("jetstream - push sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
    deliver_subject: "here",
  });

  const js = nc.jetstream();

  await js.publish(name);
  await js.publish(name);

  const sub = await js.subscribe(name, consumerOpts().bind(name, name));
  const sync = syncIterator(sub);
  assertExists(await sync.next());
  assertExists(await sync.next());

  await cleanup(ns, nc);
});

Deno.test("jetstream - pull sync", async () => {
  const { ns, nc } = await setup(jetstreamServerConf());
  const name = nuid.next();
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name,
    subjects: [name],
    storage: StorageType.Memory,
  });
  await jsm.consumers.add(name, {
    durable_name: name,
    ack_policy: AckPolicy.Explicit,
  });

  const js = nc.jetstream();

  await js.publish(name);
  await js.publish(name);

  const sub = await js.pullSubscribe(name, consumerOpts().bind(name, name));
  sub.pull({ batch: 2, no_wait: true });
  const sync = syncIterator(sub);

  assertExists(await sync.next());
  assertExists(await sync.next());
  // if don't unsubscribe, the call will hang because
  // we are waiting for the sub.pull() to happen
  sub.unsubscribe();
  assertEquals(await sync.next(), null);

  await cleanup(ns, nc);
});
