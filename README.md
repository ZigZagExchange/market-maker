# Zigzag Market Maker

This is the reference market maker for arbitrum markets. It works on both Goerli and Mainnet.

This market maker uses existing price feeds to set bids and asks for a market. For now, in order to provide liquidity for a market, there must be an existing market with **greater** liquidity listed on Cryptowatch, via either Uniswap or some other centralized exchange. It is crucial that the oracle market have more liquidity than the Zigzag one so that you are not prone to oracle attacks.

Soon we will add the ability to run standalone markets and this will not be an issue.


## Security advice

__Do not share your private key__

Running the bot on a VPS has many advantages. But you need to make sure your system is safe. If someone gains access to your system, all files can be compromised __including your private key__. There a quite a few good guides about how to keep your VPS safe:

- An Introduction to Securing your Linux VPS - [Digitalocean](https://www.digitalocean.com/community/tutorials/an-introduction-to-securing-your-linux-vps)
- 9 Ways To Keep Your VPS Secure - [namecheap](https://www.namecheap.com/blog/9-ways-to-keep-your-vps-secure/)



## Requirements

* Ethereum private key of that account
* Funds in that account corresponding to the pairs you want to market make
* [Cryptowatch API key](https://cryptowat.ch/account/api-access) (free for limited time)
* [Node.js](https://nodejs.org/en/download/)
* Node.js 16 works on macOS, Windows and Linux (17 seems not)
* Optional: VPS when you dont want to run a home PC 24/7

## Setup

Copy the `config.json.EXAMPLE` file to `config.json` to get started.

Set your `ethPrivKey` to be able to relay transactions. The ETH address with that private key should be loaded up with adequate funds for market making.

To run the marketmaker:

```bash
node marketmaker.js
```

## Configuration Via Environment Variables

It is __recommended__ to use environment variables to set your private keys. You can set `ETH_PRIVKEY`, `CRYPTOWATCH_API_KEY` and `INFURA_URL` using them. You can set them using `ETH_PRIVKEY=0x____`. For more informations on private keys read [this](https://linuxize.com/post/how-to-set-and-list-environment-variables-in-linux/).

If your hosting service requires you to pass in configs via environment variables you can compress `config.json`:

```
cat config.json | tr -d ' ' | tr -d '\n'
```

and set it to the value of the `MM_CONFIG` environment variable to override the config file.

## Settings

#### Mainnet arbitrum
- "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com"
- "zigzagChainId": 42161

#### Goerli arbitrum
- "zigzagWsUrl": "wss://secret-thicket-93345.herokuapp.com"
- "zigzagChainId": 421613

You can add, remove, and configure pair settings in the `pairs` section. A pair setting looks like this:

```json
"ETH-USDC": {
    "mode": "pricefeed",
    "side": "d",
    "initPrice": null,
    "priceFeedPrimary": "cryptowatch:6631",
    "priceFeedSecondary": "cryptowatch:588",
    "slippageRate": 1e-5,
    "maxSize": 100,
    "minSize": 0.0003,
    "minSpread": 0.0005,
    "active": true
}
```

A market can be set inactive by flipping the active switch to `false`.

The `side` setting can be toggled for single-sided liquidity. By default, the side setting is set to `d`, which stands for double-sided liquidity. To toggle single-sided liquidity, the value can be set to `b` or `s` for buy-side only or sell-side only.

The slippage rate is the rate at which the spread increases as the base unit increases. For the example above, the spread goes up by 1e-5 for every 1 ETH in size added to an order. That's the equivalent of 0.1 bps / ETH in slippage.

Orders coming in below the `minSpread` from the price feed will not be filled. The spread is calculated as a decimal value. 0.01 is 1%, and 0.0002 is 2 basis points (bps).


#### Price Feed

There are 4 modes available with a 5th on the way.

* `cryptowatch`: Follows an external price oracle.
* `chainlink` : Follows an external price oracle. Chainlink is WEB3 and might be slower then cryptowatch.
* `constant`: Sets an fixed price and market makes around that price. Can be combined with single-sided liquidity to simulate limit orders.
* `uniswapV3`: Reads prices on-chain from a specified uniswapV3 pool

**Warning:** Make sure your price feed is close to the price you see on zigzag. **Otherwise, your mm can lose money!**

For all modes the `slippageRate`, `maxSize`, `minSize`, `minSpread`, and `active` settings are mandatory.

The primary price feed is the price feed used to determine the bids and asks of the market maker. The secondary price feed is used to validate the first price feed and make sure the market isn't returning bad data. If the primary and secondary price feeds vary by more than 3%, the market maker will not fill orders.

###### Cryptowatch
You need a Cryptowatch API key to use the market maker. Once you obtain one, you can set the `cryptowatchApiKey` field in `config.json`. And set it to your public key.

You can use [this link](https://api.cryptowat.ch/markets) to download a JSON with all available market endpoints. Add those to you pair config as "cryptowatch:<id>".

Example:
```json
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "cryptowatch:6631",
    "priceFeedSecondary": "cryptowatch:588",
    ....
}
```

###### Chainlink
With chainlink you have access to price oracles via blockchain. The requests are read-calls to a smart contract. The public ethers provider might be too slow for a higher number of pairs or at times of high demand. Therefore, it might be needed to have access to an Infura account (100000 Requests/Day for free). You can get an endpoint for your market maker (like https://mainnet.infura.io/v3/...), You can add this with the `infuraUrl` field in `config.json`, like this:
```json
"infuraUrl": "https://mainnet.infura.io/v3/xxxxxxxx",
"pairs": {
  "ETH-USDC": {
      "zigzagChainId": 1,
      "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com",
      ....
  }
```
You can get the available market contracts [here.](https://docs.chain.link/docs/ethereum-addresses/)Add those to you pair config as "chainlink:<address>", like this:
```json
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "chainlink:0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "priceFeedSecondary": null,
    ....
}
```

###### UniswapV3
With uniswapV3 you have access to price feed's via blockchain. The requests are read-calls to a smart contract. The public ethers provider might be too slow for a higher number of pairs or at times of high demand. Therefore, it might be needed to have access to an Infura account (100000 Requests/Day for free). You can get an endpoint for your market maker (like https://mainnet.infura.io/v3/...), You can add this with the `infuraUrl` field in `config.json`, like this:
```json
"infuraUrl": "https://mainnet.infura.io/v3/xxxxxxxx",
"pairs": {
  "ETH-USDC": {
      "zigzagChainId": 1,
      "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com",
      ....
  }
```
You can get the available market contracts [here.](https://info.uniswap.org) Select a token and then a pool matching the pair you plan to market make. Make sure base and quote tokens match (USDC-ETH don't work for ETH-USDC). After selecting a pool, you can see the adress in the browser URL. Add that to your pair config as "uniswapv3:<address>", like this:
```json
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "uniswapv3:0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "priceFeedSecondary": null,
    ....
}
```

###### Constant
With constant mode, you can set a fixed price to market make. The bot will not change that price. Any secondary price feed will be ignored, if used as priceFeedPrimary. Also good as a `priceFeedSecondary` on stablecoins.

```json
"DAI-USDC": {
    "side": "d",
    "priceFeedPrimary": "constant:1",
    "priceFeedSecondary": null,
    ....
}
```

###### Invert price feed
For some pairs, you might just find a price feed for the inverse of the pair. If you want to mm for ZZ-USDC and only find a USDC-ZZ price feed. In those cases, you need to invert the fee. This will only work if the secondary price feed is inverted as well or set to null.
Example:
```json
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "uniswapv3:0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "priceFeedSecondary": null,
    "invert": true,
    ....
}
```

###### numOrdersIndicated
On the UI, when indicating liquidity, by default will indicate the liquidity in 10 separate orders spaced evenly apart. To change the number of orders indicated, you can use the `numOrdersIndicated` setting.

Example:
```json
"ETH-USDC": {
    "mode": "pricefeed",
    "side": "b",
    "priceFeedPrimary": "cryptowatch:6631",
    "priceFeedSecondary": "cryptowatch:588",
    "slippageRate": 1e-5,
    "maxSize": 100,
    "minSize": 0.0003,
    "minSpread": 0.0005,
    "active": true,
    "numOrdersIndicated": 5
}
```

## Vaults

Vaults offer a oportunity for users to deposit assets to a Vault contract. Each Vault has a manager that can market make for that Vault. The profits from that will be shared between all depositors. For this first version (V0) only ZigZag will be allowed to operate a Vault. Later we will add public Vaults.

Settings:
- address: On this address the Vault code is deployed
- depositFee/withdrawFee: Fees that get colleted at deposit or withdraw. These are shared between all depositors.
- initialPrice: Used on edge cases, eg. initial deposit.
- depositTokens: List of all tokens in that pool:
  - priceFeedPrimary/priceFeedSecondary: Its nessesary to add a price feed for every token in that pool.
  - active: If true used are allowed to deposit that token to the pool in exchange for LP tokens.

While using pools, the `ethPrivKey` needs to be the private key of the vault manager. He will sign orders for that vault. The marketmaking settings are the same as with a normal market maker.

```json
"vault": {
  "address": "0x341fe..32b",
  "depositFee": 0,
  "withdrawFee": 0.02,
  "initialPrice": 1,
  "depositTokens": {
    "USDC": {
      "priceFeedPrimary": "cryptowatch:61633",
      "priceFeedSecondary": null,
      "active": true
    },
    "WETH": {
      "priceFeedPrimary": "cryptowatch:6631",
      "priceFeedSecondary": null,
      "active": true
    },
    "WBTC": {
      "priceFeedPrimary": "cryptowatch:92864",
      "priceFeedSecondary": null,
      "active": true
    },
    "ZZ": {
      "priceFeedPrimary": "cryptowatch:6631",
      "priceFeedSecondary": null,
      "active": true
    }
  }
},
```
