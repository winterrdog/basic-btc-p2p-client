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
  MAGIC_BYTES.writeUInt32LE(0x0709110b); // testnet magic number

  const PORT = 18_333; // testnet port number
  const socket = connToBtcNode();
  await waitForSocketReadiness();

  // 1. send version msg. u cannot proceed without it
  console.log("+ sending version message to remote peer BTC node");
  await sendVersionMessage();

  // 2. receive version msg from remote peer BTC node
  console.log("+ waiting to receive version message from remote peer BTC node");
  await readVersionMsg();

  // 3. receive version ack msg (verack) from remote peer BTC node
  try {
    console.log(
      "+ waiting to receive version ack message from remote peer BTC node"
    );

    await Promise.race([
      readVerAckMsg(),
      new Promise(function (_, reject) {
        return setTimeout(function () {
          return reject(
            new Error(
              `
Timed out (10s) while waiting for 'verack' message. 

NOTE: Probably the peer is running a bitcoin core version that does NOT acknowledge our version message thus leading to a partial handshake. This is OK, do not fret.
`
            )
          );
        }, 10_000);
      }),
    ]);

    // 4. send verack immediately after receiving version
    console.log("+ sending my version ack message to remote peer BTC node");
    await sendMyVerAckMsg();
  } catch (e: any) {
    console.error(e.message);
  }

  console.log("+ handshake complete! 🎉");

  // keep reading msgs from remote peer
  console.log("+ waiting on more msgs from peer...");
  while (1) {
    // keep getting bytes from socket
    let msg: BtcProtocolMsg;

    while (1) {
      msg = await parseMsgFromRemotePeer();
      if (msg.magicBytes.equals(MAGIC_BYTES)) {
        logBtcMsg(msg);
        break;
      }
    }
  }

  // =======
  // HELPERS
  // =======

  async function sendMyVerAckMsg() {
    const msg = buildVersionAckMsg();
    await asyncSockWrite(msg);
  }

  async function readVerAckMsg() {
    const msg = await parseMsgFromRemotePeer();
    console.log("> VERSION ACK MSG:");
    logBtcMsg(msg);
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
      // Buffer.from("00000000000000000000ffffa27845b6", "hex"),
      Buffer.from("00000000000000000000ffff7f000001", "hex"),
      remotePort,
    ]);

    // NOTE
    // addr for sender
    // Field can be ignored. This used to be the network address of the node emitting this message,
    // but most P2P implementations send 26 dummy bytes. The "services" field of the address would
    // also be redundant with the second field of the version message.

    const addrSender = Buffer.alloc(26);

    const userAgent = Buffer.from("00", "hex");

    const nonce = randomBytes(8);
    const lastBlockRecvd = Buffer.alloc(4);
    lastBlockRecvd.writeUInt32LE(0);

    const relay = Buffer.from([0x0]);

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
      relay,
    ]);

    return payload;
  }

  function genVersionMsgHdr(payload: Buffer) {
    const cmd = Buffer.alloc(12);
    cmd.write("version", "ascii");

    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);

    const chkSum = doubleSha256(payload);

    // be careful with the ordering too when combining pieces of data
    const header = Buffer.concat([MAGIC_BYTES, cmd, size, chkSum]);
    return header;
  }

  function buildVersionMsg() {
    // each msg has a header and a payload.
    const payload = genVersionMsgPayload();
    const header = genVersionMsgHdr(payload);
    return Buffer.concat([header, payload]);
  }

  async function sendVersionMessage() {
    const versionMsg = buildVersionMsg();
    await asyncSockWrite(versionMsg);
  }

  function genVersionAckMsgHdr(payload: Buffer) {
    const cmd = Buffer.alloc(12);
    cmd.write("verack", "ascii");

    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);

    const chkSum = doubleSha256(payload);

    //     console.log(`
    // VERSION ACK:
    // magic bytes: ${magicBytes.toString("hex")},
    // command: verack,
    // size: ${size.readUint32LE(0)},
    // checksum: ${chkSum.toString("hex")},
    // payload: ${payload.toString("hex")}`);

    // be careful with the ordering too when combining pieces of data
    const header = Buffer.concat([MAGIC_BYTES, cmd, size, chkSum]);
    return header;
  }

  function buildVersionAckMsg() {
    const payload = Buffer.alloc(0); // verack msgs lack a payload
    const header = genVersionAckMsgHdr(payload);
    return Buffer.concat([header, payload]);
  }

  function asyncSockWrite(data: Buffer) {
    return new Promise<void>(function (resolve, reject) {
      socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  function connToBtcNode() {
    // const ip = "162.120.69.182"; // my local node
    const ip = "127.0.0.1"; // my local node
    const socket = createConnection({ port: PORT, host: ip, family: 4 }, () => {
      console.log(`+ connected sucessfully to btc node at: ${ip}:${PORT}`);
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
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
