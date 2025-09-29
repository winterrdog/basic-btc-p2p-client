// NOTE:
// I could have used UInt8Array instead of Buffer everywhere.
// But Buffer has some nice methods like .readUInt32LE() that makes
// reading data from a stream easier.

// Also, Buffer is a subclass of UInt8Array soooooo... it should be fine. But
// I also happen to be more familiar with Buffer than UInt8Array so i ended up using
// Buffer everywhere, cuz why not!!
// see: https://nodejs.org/api/buffer.html#buffer_class_buffer

import { createConnection } from "node:net";
import { createHash, randomBytes } from "node:crypto";

main().catch((err) => console.error("unknown error occured", err));

// ===============
// implementation
// ===============

interface BtcProtocolMsg {
  magicBytes: Buffer;
  cmd: Buffer;
  size: number;
  checksum: Buffer;
  payload: Buffer;
}

async function main() {
  const MAGIC_BYTES = Buffer.alloc(4);
  MAGIC_BYTES.writeUInt32LE(0xd9b4bef9); // mainnet magic number

  // MAGIC_BYTES.writeUInt32LE(0xDAB5BFFA); // regtest magic number
  // MAGIC_BYTES.writeUInt32LE(0x0709110b); // testnet magic number

  const PORT = 8333; // mainnet port number

  // const PORT = 18_444; // regtest port number
  // const PORT = 18_333; // testnet port number

  const socket = connToBtcNode();
  await waitForSocketReadiness();

  // 1. send version msg. u cannot proceed without it
  console.log("+ sending version message to remote peer BTC node");
  await sendVersionMessage();

  // 2. receive version msg from remote peer BTC node
  console.log("+ waiting to receive version message from remote peer BTC node");
  await readVersionMsg();

  // 3. send verack immediately after receiving version (don't wait for their verack)
  console.log("+ sending my version ack message to remote peer BTC node");
  await sendMyVerAckMsg();

  // 4. try to receive their verack, but don't block if it doesn't come
  try {
    console.log(
      "+ waiting to receive version ack message from remote peer BTC node"
    );

    const verackMsg = await Promise.race([
      readVerAckMsg(),
      new Promise<BtcProtocolMsg>((_, reject) => {
        setTimeout(() => reject(new Error("verack timeout")), 5_000);
      }),
    ]);

    console.log("> VERSION ACK MSG:");
    logBtcMsg(verackMsg);
  } catch (e: any) {
    console.log("+ verack not received within timeout, continuing anyway...");
  }

  console.log("+ handshake complete! 🎉");

  // keep reading msgs from remote peer
  console.log("+ waiting on more msgs from peer...");
  let msg: BtcProtocolMsg | null = null;

  do {
    // keep getting bytes from socket
    msg = null;

    while (1) {
      msg = await parseMsgFromRemotePeer();
      if (areBuffersEqual(msg.magicBytes, MAGIC_BYTES)) {
        logBtcMsg(msg);

        const command = getCommandString(msg.cmd);
        if (command === "inv") {
          console.log("+ received 'inv' msg");
          // respond to 'inv' cmds
          // send back 'getdata' msgs to get blocks. use the same payload as that of 'inv'
          // in order to get EVERYTHING there is.
          const payload = msg.payload;
          const header = createBtcMsgHeader("getdata", payload);

          // be careful with the ordering too when combining pieces of data
          const getdataMsg = Buffer.concat([header, payload]);
          await asyncSockWrite(getdataMsg);

          console.log("+ sent back 'getdata' msg\n");
        } else if (command === "ping") {
          console.log("+ received 'ping' msg");
          // send back a 'pong' with the same payload as the 'ping'
          const payload = msg.payload;
          const header = createBtcMsgHeader("pong", payload);
          await asyncSockWrite(Buffer.concat([header, payload]));

          console.log("+ sent back 'pong' msg\n");
        }

        break;
      }
    }
  } while (1);

  // =======
  // HELPERS
  // =======

  function areBuffersEqual(a: Buffer, b: Buffer) {
    return a.length === b.length && a.compare(b) === 0;
  }

  function createBtcMsgHeader(cmdStr: string, payload: Buffer) {
    const cmd = Buffer.alloc(12);
    cmd.write(cmdStr, "ascii");

    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);

    const chkSum = doubleSha256(payload);

    // be careful with the ordering too when combining pieces of data
    const header = Buffer.concat([MAGIC_BYTES, cmd, size, chkSum]);
    return header;
  }

  async function sendMyVerAckMsg() {
    const msg = buildVersionAckMsg();
    await asyncSockWrite(msg);
  }

  async function readVerAckMsg() {
    const msg = await parseMsgFromRemotePeer();
    console.log("> VERSION ACK MSG:");
    return msg;
  }

  async function readVersionMsg() {
    var msg = await parseMsgFromRemotePeer();
    console.log("> VERSION MSG HEADER:");
    logBtcMsg(msg);
  }

  function logBtcMsg(msg: {
    magicBytes: Buffer;
    cmd: Buffer;
    size: number;
    checksum: Buffer;
    payload: Buffer;
  }) {
    const { magicBytes, cmd, checksum, payload, size } = msg;

    console.log(`> magic bytes: ${magicBytes.toString("hex")},
> command: ${cmd.toString("ascii")},
> size: ${size} bytes,
> checksum: ${checksum.toString("hex")}
> payload: ${!!size ? payload.toString("hex") : "none"}
      `);
  }

  async function parseMsgFromRemotePeer(): Promise<BtcProtocolMsg> {
    // header
    var magicBytes = await readNBytes(4);
    var cmd = await readNBytes(12);
    var size = (await readNBytes(4)).readUint32LE(0);
    var checksum = await readNBytes(4);

    // payload
    var payload = await readNBytes(size);

    return { magicBytes, cmd, size, checksum, payload };
  }

  function readNBytes(n: number) {
    return new Promise<Buffer>(function (resolve, reject) {
      let totalRead = 0;
      let chunks: Buffer[] = [];
      let isResolved = false;

      socket.on("error", onError);
      socket.on("close", onClose);

      tryRead();

      // =====
      // helpers
      // =====

      function cleanup() {
        socket.removeListener("readable", tryRead);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      }
      function onError(err: Error) {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(err);
        }
      }
      function onClose() {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(new Error("Socket closed while reading"));
        }
      }
      function tryRead() {
        const remainingBytes = n - totalRead;
        const data: Buffer | null = socket.read(remainingBytes);

        if (data) {
          // if we've data, collect it and check if we're at the
          // target spot, then resolve and send back only the data we need
          chunks.push(data);
          totalRead += data.length;
          if (totalRead >= n) {
            if (!isResolved) {
              isResolved = true;
              cleanup();
              const result = Buffer.concat(chunks);
              return resolve(result.subarray(0, n));
            }
          }
        }

        // only add listeners if we haven't resolved yet
        if (!isResolved) {
          socket.once("readable", tryRead);
        }
      }
    });
  }

  function doubleSha256(data: Buffer): Buffer {
    // double hash in order to get checksum
    const h1 = createHash("sha256").update(data).digest();
    const h2 = createHash("sha256").update(h1).digest();

    // return the first 4 bytes
    return Buffer.from(h2.subarray(0, 4));
  }

  function genVersionMsgPayload() {
    const version = Buffer.alloc(4);
    version.writeInt32LE(70014); // little-endian

    const services = Buffer.alloc(8);
    services.writeBigUInt64LE(BigInt(0));

    const time = Buffer.alloc(8);
    const secsEpoch = Math.floor(Date.now() / 1_000);
    time.writeBigInt64LE(BigInt(secsEpoch));

    // addr for receiver
    const remoteServices = Buffer.alloc(8);
    remoteServices.writeBigUInt64LE(0n);

    const remotePort = Buffer.alloc(2);
    remotePort.writeUInt16BE(PORT);

    const addrRecv = Buffer.concat([
      remoteServices,
      Buffer.from("00000000000000000000ffff2e13894a", "hex"),
      // Buffer.from("00000000000000000000ffff7f000001", "hex"),
      remotePort,
    ]);

    // NOTE
    // addr for sender
    // Field can be ignored. This used to be the network address of the node emitting this message,
    // but most P2P implementations send 26 dummy bytes. The "services" field of the address would
    // also be redundant with the second field of the version message.

    const addrSender = Buffer.concat([
      remoteServices,
      Buffer.from("00000000000000000000ffff7f000001", "hex"),
      remotePort,
    ]);

    const userAgent = Buffer.from("00", "hex");

    const nonce = randomBytes(8);
    const lastBlockRecvd = Buffer.alloc(4);
    lastBlockRecvd.writeUInt32LE(0);

    // const relay = Buffer.from([0x0]);

    // be careful with the ordering too when combining pieces of data
    const payload = Buffer.concat([
      version,
      services,
      time,
      addrRecv,
      addrSender,
      nonce,
      userAgent,
      lastBlockRecvd,
      // relay,
    ]);

    return payload;
  }

  function buildVersionMsg() {
    // each msg has a header and a payload.
    const payload = genVersionMsgPayload();
    const header = createBtcMsgHeader("version", payload);
    return Buffer.concat([header, payload]);
  }

  async function sendVersionMessage() {
    const versionMsg = buildVersionMsg();
    await asyncSockWrite(versionMsg);
  }

  function buildVersionAckMsg() {
    const payload = Buffer.alloc(0); // verack msgs lack a payload
    const header = createBtcMsgHeader("verack", payload);
    return Buffer.concat([header, payload]);
  }

  function asyncSockWrite(data: Buffer) {
    return new Promise<void>(function (resolve, reject) {
      socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  function getCommandString(cmdBuffer: Buffer): string {
    return cmdBuffer.toString("ascii").replace(/\0/g, "");
  }

  function connToBtcNode() {
    // const ip = "162.120.69.182"; // my local node
    const ip = "162.120.69.182"; // my local node
    const socket = createConnection({ port: PORT, host: ip }, () => {
      console.log(`+ connected sucessfully to btc node at: ${ip}:${PORT}`);
    });

    socket.on("error", (err) => {
      console.error("A socket error:", err.stack || err.message);
    });
    socket.on("close", () => {
      console.log("Socket closed by remote peer");
    });

    return socket;
  }

  function waitForSocketReadiness() {
    return new Promise<void>(function (resolve) {
      socket.once("ready", () => resolve());
    });
  }
}
