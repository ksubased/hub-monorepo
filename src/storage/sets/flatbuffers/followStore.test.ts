import Factories from '~/test/factories/flatbuffer';
import { jestBinaryRocksDB } from '~/storage/db/jestUtils';
import MessageModel from '~/storage/flatbuffers/messageModel';
import { FollowAddModel, FollowRemoveModel, UserPostfix } from '~/storage/flatbuffers/types';
import FollowStore from '~/storage/sets/flatbuffers/followStore';
import { HubError } from '~/utils/hubErrors';
import { bytesDecrement, bytesIncrement, getFarcasterTime } from '~/storage/flatbuffers/utils';
import { MessageType, UserId } from '~/utils/generated/message_generated';
import StoreEventHandler from '~/storage/sets/flatbuffers/storeEventHandler';

const db = jestBinaryRocksDB('flatbuffers.followStore.test');
const eventHandler = new StoreEventHandler();
const store = new FollowStore(db, eventHandler);
const fid = Factories.FID.build();

const userId = Factories.FID.build();
let followAdd: FollowAddModel;
let followRemove: FollowRemoveModel;

beforeAll(async () => {
  const followBody = Factories.FollowBody.build({ user: Factories.UserId.build({ fid: Array.from(userId) }) });

  const addData = await Factories.FollowAddData.create({ fid: Array.from(fid), body: followBody });
  const addMessage = await Factories.Message.create({ data: Array.from(addData.bb?.bytes() ?? []) });
  followAdd = new MessageModel(addMessage) as FollowAddModel;

  const removeData = await Factories.FollowRemoveData.create({
    fid: Array.from(fid),
    body: followBody,
    timestamp: addData.timestamp() + 1,
  });
  const removeMessage = await Factories.Message.create({ data: Array.from(removeData.bb?.bytes() ?? []) });
  followRemove = new MessageModel(removeMessage) as FollowRemoveModel;
});

describe('getFollowAdd', () => {
  test('fails if missing', async () => {
    await expect(store.getFollowAdd(fid, userId)).rejects.toThrow(HubError);
  });

  test('fails if incorrect values are passed in', async () => {
    await store.merge(followAdd);

    const invalidFid = Factories.FID.build();
    await expect(store.getFollowAdd(invalidFid, userId)).rejects.toThrow(HubError);

    const invalidUserId = Factories.FID.build();
    await expect(store.getFollowAdd(fid, invalidUserId)).rejects.toThrow(HubError);
  });

  test('returns message', async () => {
    await store.merge(followAdd);
    await expect(store.getFollowAdd(fid, userId)).resolves.toEqual(followAdd);
  });
});

describe('getFollowRemove', () => {
  test('fails if missing', async () => {
    await expect(store.getFollowRemove(fid, userId)).rejects.toThrow(HubError);
  });

  test('fails if incorrect values are passed in', async () => {
    await store.merge(followAdd);

    const invalidFid = Factories.FID.build();
    await expect(store.getFollowRemove(invalidFid, userId)).rejects.toThrow(HubError);

    const invalidUserId = Factories.FID.build();
    await expect(store.getFollowRemove(fid, invalidUserId)).rejects.toThrow(HubError);
  });

  test('returns message', async () => {
    await store.merge(followRemove);
    await expect(store.getFollowRemove(fid, userId)).resolves.toEqual(followRemove);
  });
});

describe('getFollowAddsByUser', () => {
  test('returns follow adds for an fid', async () => {
    await store.merge(followAdd);
    await expect(store.getFollowAddsByUser(fid)).resolves.toEqual([followAdd]);
  });

  test('returns empty array for wrong fid', async () => {
    await store.merge(followAdd);
    const invalidFid = Factories.FID.build();
    await expect(store.getFollowAddsByUser(invalidFid)).resolves.toEqual([]);
  });

  test('returns empty array without messages', async () => {
    await expect(store.getFollowAddsByUser(fid)).resolves.toEqual([]);
  });
});

describe('getFollowRemovesByUser', () => {
  test('returns follow removes for an fid', async () => {
    await store.merge(followRemove);
    await expect(store.getFollowRemovesByUser(fid)).resolves.toEqual([followRemove]);
  });

  test('returns empty array for wrong fid', async () => {
    await store.merge(followAdd);
    const invalidFid = Factories.FID.build();
    await expect(store.getFollowRemovesByUser(invalidFid)).resolves.toEqual([]);
  });

  test('returns empty array without messages', async () => {
    await expect(store.getFollowRemovesByUser(fid)).resolves.toEqual([]);
  });
});

describe('getFollowsByTargetUser', () => {
  test('returns empty array if no follows exist', async () => {
    const byTargetUser = await store.getFollowsByTargetUser(fid);
    expect(byTargetUser).toEqual([]);
  });

  test('returns empty array if follows exist, but for a different user', async () => {
    await store.merge(followAdd);
    const invalidFid = Factories.FID.build();
    const byTargetUser = await store.getFollowsByTargetUser(invalidFid);
    expect(byTargetUser).toEqual([]);
  });

  test('returns follows if they exist for the target user', async () => {
    const addData = await Factories.FollowAddData.create({
      body: followAdd.body().unpack() || null,
    });
    const addMessage = await Factories.Message.create({
      data: Array.from(addData.bb?.bytes() ?? []),
    });
    const followAdd2 = new MessageModel(addMessage) as FollowAddModel;

    await store.merge(followAdd);
    await store.merge(followAdd2);

    const byUser = await store.getFollowsByTargetUser(userId);
    expect(new Set(byUser)).toEqual(new Set([followAdd, followAdd2]));
  });
});

describe('merge', () => {
  const assertFollowExists = async (message: FollowAddModel | FollowRemoveModel) => {
    await expect(MessageModel.get(db, fid, UserPostfix.FollowMessage, message.tsHash())).resolves.toEqual(message);
  };

  const assertFollowDoesNotExist = async (message: FollowAddModel | FollowRemoveModel) => {
    await expect(MessageModel.get(db, fid, UserPostfix.FollowMessage, message.tsHash())).rejects.toThrow(HubError);
  };

  const assertFollowAddWins = async (message: FollowAddModel) => {
    await assertFollowExists(message);
    await expect(store.getFollowAdd(fid, userId)).resolves.toEqual(message);
    await expect(store.getFollowsByTargetUser(userId)).resolves.toEqual([message]);
    await expect(store.getFollowRemove(fid, userId)).rejects.toThrow(HubError);
  };

  const assertFollowRemoveWins = async (message: FollowRemoveModel) => {
    await assertFollowExists(message);
    await expect(store.getFollowRemove(fid, userId)).resolves.toEqual(message);
    await expect(store.getFollowsByTargetUser(userId)).resolves.toEqual([]);
    await expect(store.getFollowAdd(fid, userId)).rejects.toThrow(HubError);
  };

  test('fails with invalid message type', async () => {
    const invalidData = await Factories.ReactionAddData.create({ fid: Array.from(fid) });
    const message = await Factories.Message.create({ data: Array.from(invalidData.bb?.bytes() ?? []) });
    await expect(store.merge(new MessageModel(message))).rejects.toThrow(HubError);
  });

  describe('FollowAdd', () => {
    test('succeeds', async () => {
      await expect(store.merge(followAdd)).resolves.toEqual(undefined);
      await assertFollowAddWins(followAdd);
    });

    test('succeeds once, even if merged twice', async () => {
      await expect(store.merge(followAdd)).resolves.toEqual(undefined);
      await expect(store.merge(followAdd)).resolves.toEqual(undefined);

      await assertFollowAddWins(followAdd);
    });

    describe('with a conflicting FollowAdd with different timestamps', () => {
      let followAddLater: FollowAddModel;

      beforeAll(async () => {
        const addData = await Factories.FollowAddData.create({
          ...followAdd.data.unpack(),
          timestamp: followAdd.timestamp() + 1,
        });
        const addMessage = await Factories.Message.create({
          data: Array.from(addData.bb?.bytes() ?? []),
        });
        followAddLater = new MessageModel(addMessage) as FollowAddModel;
      });

      test('succeeds with a later timestamp', async () => {
        await store.merge(followAdd);
        await expect(store.merge(followAddLater)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAdd);
        await assertFollowAddWins(followAddLater);
      });

      test('no-ops with an earlier timestamp', async () => {
        await store.merge(followAddLater);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAdd);
        await assertFollowAddWins(followAddLater);
      });
    });

    describe('with a conflicting FollowAdd with identical timestamps', () => {
      let followAddLater: FollowAddModel;

      beforeAll(async () => {
        const addData = await Factories.FollowAddData.create({
          ...followAdd.data.unpack(),
        });

        const addMessage = await Factories.Message.create({
          data: Array.from(addData.bb?.bytes() ?? []),
          hash: Array.from(bytesIncrement(followAdd.hash().slice())),
        });

        followAddLater = new MessageModel(addMessage) as FollowAddModel;
      });

      test('succeeds with a later hash', async () => {
        await store.merge(followAdd);
        await expect(store.merge(followAddLater)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAdd);
        await assertFollowAddWins(followAddLater);
      });

      test('no-ops with an earlier hash', async () => {
        await store.merge(followAddLater);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAdd);
        await assertFollowAddWins(followAddLater);
      });
    });

    describe('with conflicting FollowRemove with different timestamps', () => {
      test('succeeds with a later timestamp', async () => {
        const removeData = await Factories.FollowRemoveData.create({
          ...followRemove.data.unpack(),
          timestamp: followAdd.timestamp() - 1,
        });

        const removeMessage = await Factories.Message.create({
          data: Array.from(removeData.bb?.bytes() ?? []),
        });

        const followRemoveEarlier = new MessageModel(removeMessage) as FollowRemoveModel;

        await store.merge(followRemoveEarlier);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowAddWins(followAdd);
        await assertFollowDoesNotExist(followRemoveEarlier);
      });

      test('no-ops with an earlier timestamp', async () => {
        await store.merge(followRemove);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowRemoveWins(followRemove);
        await assertFollowDoesNotExist(followAdd);
      });
    });

    describe('with conflicting FollowRemove with identical timestamps', () => {
      test('no-ops if remove has a later hash', async () => {
        const removeData = await Factories.FollowRemoveData.create({
          ...followRemove.data.unpack(),
          timestamp: followAdd.timestamp(),
        });

        const removeMessage = await Factories.Message.create({
          data: Array.from(removeData.bb?.bytes() ?? []),
          hash: Array.from(bytesIncrement(followAdd.hash().slice())),
        });

        const followRemoveLater = new MessageModel(removeMessage) as FollowRemoveModel;

        await store.merge(followRemoveLater);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowRemoveWins(followRemoveLater);
        await assertFollowDoesNotExist(followAdd);
      });

      test('succeeds if remove has an earlier hash', async () => {
        const removeData = await Factories.FollowRemoveData.create({
          ...followRemove.data.unpack(),
          timestamp: followAdd.timestamp(),
        });

        const removeMessage = await Factories.Message.create({
          data: Array.from(removeData.bb?.bytes() ?? []),

          // TODO: this slice doesn't seem necessary, and its also in reactions
          // TODO: rename set to store in reactions, signer and other places
          hash: Array.from(bytesDecrement(followAdd.hash().slice())),
        });

        const followRemoveEarlier = new MessageModel(removeMessage) as FollowRemoveModel;

        await store.merge(followRemoveEarlier);
        await expect(store.merge(followAdd)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAdd);
        await assertFollowRemoveWins(followRemoveEarlier);
      });
    });
  });

  describe('FollowRemove', () => {
    test('succeeds', async () => {
      await expect(store.merge(followRemove)).resolves.toEqual(undefined);

      await assertFollowRemoveWins(followRemove);
    });

    test('succeeds once, even if merged twice', async () => {
      await expect(store.merge(followRemove)).resolves.toEqual(undefined);
      await expect(store.merge(followRemove)).resolves.toEqual(undefined);

      await assertFollowRemoveWins(followRemove);
    });

    describe('with a conflicting FollowRemove with different timestamps', () => {
      let followRemoveLater: FollowRemoveModel;

      beforeAll(async () => {
        const followRemoveData = await Factories.FollowRemoveData.create({
          ...followRemove.data.unpack(),
          timestamp: followRemove.timestamp() + 1,
        });
        const followRemoveMessage = await Factories.Message.create({
          data: Array.from(followRemoveData.bb?.bytes() ?? []),
        });
        followRemoveLater = new MessageModel(followRemoveMessage) as FollowRemoveModel;
      });

      test('succeeds with a later timestamp', async () => {
        await store.merge(followRemove);
        await expect(store.merge(followRemoveLater)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followRemove);
        await assertFollowRemoveWins(followRemoveLater);
      });

      test('no-ops with an earlier timestamp', async () => {
        await store.merge(followRemoveLater);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followRemove);
        await assertFollowRemoveWins(followRemoveLater);
      });
    });

    describe('with a conflicting FollowRemove with identical timestamps', () => {
      let followRemoveLater: FollowRemoveModel;

      beforeAll(async () => {
        const followRemoveData = await Factories.FollowRemoveData.create({
          ...followRemove.data.unpack(),
        });

        const addMessage = await Factories.Message.create({
          data: Array.from(followRemoveData.bb?.bytes() ?? []),
          hash: Array.from(bytesIncrement(followRemove.hash().slice())),
        });

        followRemoveLater = new MessageModel(addMessage) as FollowRemoveModel;
      });

      test('succeeds with a later hash', async () => {
        await store.merge(followRemove);
        await expect(store.merge(followRemoveLater)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followRemove);
        await assertFollowRemoveWins(followRemoveLater);
      });

      test('no-ops with an earlier hash', async () => {
        await store.merge(followRemoveLater);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followRemove);
        await assertFollowRemoveWins(followRemoveLater);
      });
    });

    describe('with conflicting FollowAdd with different timestamps', () => {
      test('succeeds with a later timestamp', async () => {
        await store.merge(followAdd);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);
        await assertFollowRemoveWins(followRemove);
        await assertFollowDoesNotExist(followAdd);
      });

      test('no-ops with an earlier timestamp', async () => {
        const addData = await Factories.FollowAddData.create({
          ...followRemove.data.unpack(),
          timestamp: followRemove.timestamp() + 1,
          type: MessageType.FollowAdd,
        });
        const addMessage = await Factories.Message.create({
          data: Array.from(addData.bb?.bytes() ?? []),
        });
        const followAddLater = new MessageModel(addMessage) as FollowAddModel;
        await store.merge(followAddLater);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);
        await assertFollowAddWins(followAddLater);
        await assertFollowDoesNotExist(followRemove);
      });
    });

    describe('with conflicting FollowAdd with identical timestamps', () => {
      test('succeeds with an earlier hash', async () => {
        const addData = await Factories.FollowAddData.create({
          ...followRemove.data.unpack(),
          type: MessageType.FollowAdd,
        });

        const addMessage = await Factories.Message.create({
          data: Array.from(addData.bb?.bytes() ?? []),
          hash: Array.from(bytesIncrement(followRemove.hash().slice())),
        });
        const followAddLater = new MessageModel(addMessage) as FollowAddModel;

        await store.merge(followAddLater);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followAddLater);
        await assertFollowRemoveWins(followRemove);
      });

      test('succeeds with a later hash', async () => {
        const removeData = await Factories.FollowAddData.create({
          ...followRemove.data.unpack(),
        });

        const removeMessage = await Factories.Message.create({
          data: Array.from(removeData.bb?.bytes() ?? []),
          hash: Array.from(bytesDecrement(followRemove.hash().slice())),
        });

        const followRemoveEarlier = new MessageModel(removeMessage) as FollowRemoveModel;

        await store.merge(followRemoveEarlier);
        await expect(store.merge(followRemove)).resolves.toEqual(undefined);

        await assertFollowDoesNotExist(followRemoveEarlier);
        await assertFollowRemoveWins(followRemove);
      });
    });
  });
});

describe('pruneMessages', () => {
  let prunedMessages: MessageModel[];
  const pruneMessageListener = (message: MessageModel) => {
    prunedMessages.push(message);
  };

  beforeAll(() => {
    eventHandler.on('pruneMessage', pruneMessageListener);
  });

  beforeEach(() => {
    prunedMessages = [];
  });

  afterAll(() => {
    eventHandler.off('pruneMessage', pruneMessageListener);
  });

  let add1: FollowAddModel;
  let add2: FollowAddModel;
  let add3: FollowAddModel;
  let add4: FollowAddModel;
  let add5: FollowAddModel;
  let addOld1: FollowAddModel;
  let addOld2: FollowAddModel;

  let remove1: FollowRemoveModel;
  let remove2: FollowRemoveModel;
  let remove3: FollowRemoveModel;
  let remove4: FollowRemoveModel;
  let remove5: FollowRemoveModel;
  let removeOld3: FollowRemoveModel;

  const generateAddWithTimestamp = async (fid: Uint8Array, timestamp: number): Promise<FollowAddModel> => {
    const addData = await Factories.FollowAddData.create({ fid: Array.from(fid), timestamp });
    const addMessage = await Factories.Message.create({ data: Array.from(addData.bb?.bytes() ?? []) });
    return new MessageModel(addMessage) as FollowAddModel;
  };

  const generateRemoveWithTimestamp = async (
    fid: Uint8Array,
    timestamp: number,
    user?: UserId | null
  ): Promise<FollowRemoveModel> => {
    const removeBody = await Factories.FollowBody.build(user ? { user: user.unpack() } : {});
    const removeData = await Factories.FollowRemoveData.create({ fid: Array.from(fid), timestamp, body: removeBody });
    const removeMessage = await Factories.Message.create({ data: Array.from(removeData.bb?.bytes() ?? []) });
    return new MessageModel(removeMessage) as FollowRemoveModel;
  };

  beforeAll(async () => {
    const time = getFarcasterTime() - 10;
    add1 = await generateAddWithTimestamp(fid, time + 1);
    add2 = await generateAddWithTimestamp(fid, time + 2);
    add3 = await generateAddWithTimestamp(fid, time + 3);
    add4 = await generateAddWithTimestamp(fid, time + 4);
    add5 = await generateAddWithTimestamp(fid, time + 5);
    addOld1 = await generateAddWithTimestamp(fid, time - 60 * 60);
    addOld2 = await generateAddWithTimestamp(fid, time - 60 * 60 + 1);

    remove1 = await generateRemoveWithTimestamp(fid, time + 1, add1.body().user());
    remove2 = await generateRemoveWithTimestamp(fid, time + 2, add2.body().user());
    remove3 = await generateRemoveWithTimestamp(fid, time + 3, add3.body().user());
    remove4 = await generateRemoveWithTimestamp(fid, time + 4, add4.body().user());
    remove5 = await generateRemoveWithTimestamp(fid, time + 5, add5.body().user());
    removeOld3 = await generateRemoveWithTimestamp(fid, time - 60 * 60 + 2);
  });

  describe('with size limit', () => {
    const sizePrunedStore = new FollowStore(db, eventHandler, { pruneSizeLimit: 3 });

    test('no-ops when no messages have been merged', async () => {
      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);
      expect(prunedMessages).toEqual([]);
    });

    test('prunes earliest add messages', async () => {
      const messages = [add1, add2, add3, add4, add5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);

      expect(prunedMessages).toEqual([add1, add2]);

      for (const message of prunedMessages as FollowAddModel[]) {
        const getAdd = () => sizePrunedStore.getFollowAdd(fid, message.body().user()?.fidArray() ?? new Uint8Array());
        await expect(getAdd()).rejects.toThrow(HubError);
      }
    });

    test('prunes earliest remove messages', async () => {
      const messages = [remove1, remove2, remove3, remove4, remove5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);

      expect(prunedMessages).toEqual([remove1, remove2]);

      for (const message of prunedMessages as FollowRemoveModel[]) {
        const getRemove = () =>
          sizePrunedStore.getFollowRemove(fid, message.body().user()?.fidArray() ?? new Uint8Array());
        await expect(getRemove()).rejects.toThrow(HubError);
      }
    });

    test('prunes earliest messages', async () => {
      const messages = [add1, remove2, add3, remove4, add5];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);

      expect(prunedMessages).toEqual([add1, remove2]);
    });

    test('no-ops when adds have been removed', async () => {
      const messages = [add1, remove1, add2, remove2, add3];
      for (const message of messages) {
        await sizePrunedStore.merge(message);
      }

      const result = await sizePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);

      expect(prunedMessages).toEqual([]);
    });
  });

  describe('with time limit', () => {
    const timePrunedStore = new FollowStore(db, eventHandler, { pruneTimeLimit: 60 * 60 - 1 });

    test('prunes earliest messages', async () => {
      const messages = [add1, remove2, addOld1, addOld2, removeOld3];
      for (const message of messages) {
        await timePrunedStore.merge(message);
      }

      const result = await timePrunedStore.pruneMessages(fid);
      expect(result._unsafeUnwrap()).toEqual(undefined);

      expect(prunedMessages).toEqual([addOld1, addOld2, removeOld3]);

      await expect(
        timePrunedStore.getFollowAdd(fid, addOld1.body().user()?.fidArray() ?? new Uint8Array())
      ).rejects.toThrow(HubError);
      await expect(
        timePrunedStore.getFollowAdd(fid, addOld2.body().user()?.fidArray() ?? new Uint8Array())
      ).rejects.toThrow(HubError);
      await expect(
        timePrunedStore.getFollowRemove(fid, removeOld3.body().user()?.fidArray() ?? new Uint8Array())
      ).rejects.toThrow(HubError);
    });
  });
});