# vobiz-jssip

Vobiz's JavaScript SIP library for WebRTC-based voice communication.

Based on [JsSIP](https://jssip.net/) (MIT License).

## Installation

```bash
npm install vobiz-jssip
```

## Usage

```javascript
const VobizJsSIP = require('vobiz-jssip');

const socket = new VobizJsSIP.WebSocketInterface('wss://your-sip-server.com');

const ua = new VobizJsSIP.UA({
  sockets: [socket],
  uri: 'sip:user@your-domain.com',
  password: 'your-password'
});

ua.start();
```

## License

MIT
