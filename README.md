# a basic Bitcoin P2P client

This is a simple implementation of a Bitcoin P2P Network client. It connects to a Bitcoin node, performs the handshake, and listens for incoming messages. And that's all.

OKaaay! oh...! but it tries to handle '`ping`' and '`inv`' only.

I created this project for learning purposes, so don't expect too much from it. I believe that if _i cannot create something, i cannot understand it too_ (inspired by Richard Feynman).

Make sure your Node.js version has **stable TypeScript support** before running this code. That is any Node.js version >= v23.6.0 or any latest LTS release.

## features

- Connects to a Bitcoin node
- Performs the handshake, albeit in a very odd way. we just timeout when we expect a '`verack`' message from the remote peer. I think it'd be due to the fact they're running a different version of Bitcoin Core that uses the encryption feature, but the handshake still works in the very same way it used to work before the encryption feature was added.
- Listens for all incoming messages directed to it
- Handles '`ping`' and '`inv`' messages
- Replies to '`inv`' messages with a '`getdata`' message in which it requests for everything in remote peer's inventory
- Logs all incoming messages to the console (kinda silly, but yeah!)
- Written in TypeScript
- Zero dependencies.

# usage

1. Clone the repository
```bash
git clone https://github.com/winterrdog/basic-btc-p2p-client.git
```

2. Run:

```bash
cd src
npm start
```

# notes

- The client connects to a hardcoded Bitcoin node at `162.120.69.182:8333` (you can change it in the code).
- by default, we used the `mainnet` on this. you can always edit the `createGlobalConfig()` local function in the `main()` function in the `client.ts` file to change the network to `testnet` or `regtest`.
- tried to use functional programming (some parts aren't pure functions, but it's OK here) as much as possible. personally, i find it easier to read and understand due to having a mathematical background. it also offers a bit of stability and predictability to my code.

# license

WTFPLv2
