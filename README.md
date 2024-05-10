# Crypto-AIO

All-In-One Crypto-Currency for Backend

[![Build, Test and Publish](https://github.com/vhidvz/crypto-aio/actions/workflows/npm-ci.yml/badge.svg)](https://github.com/vhidvz/crypto-aio/actions/workflows/npm-ci.yml)
[![npm](https://img.shields.io/npm/v/crypto-aio)](https://www.npmjs.com/package/crypto-aio)
![npm](https://img.shields.io/npm/dm/crypto-aio)
[![Coverage](https://raw.githubusercontent.com/vhidvz/crypto-aio/main/docs/coverage.svg)](https://htmlpreview.github.io/?https://github.com/vhidvz/crypto-aio/blob/main/docs/coverage/lcov-report/index.html)
[![GitHub](https://img.shields.io/github/license/vhidvz/crypto-aio?style=flat)](https://github.com/vhidvz/crypto-aio/blob/master/LICENSE)
[![documentation](https://img.shields.io/badge/documentation-click_to_read-c27cf4)](https://vhidvz.github.io/crypto-aio/)

## Quick Start

```ts
import { CryptoAio } from 'crypto-aio';

const caio = new CryptoAio();

caio.eth.getGasPrice();

caio.eth.createAccount();
caio.eth.account.create();

caio.eth.account.getBalance();
```
