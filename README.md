# Zigzag Market Maker

This is the reference market maker for Zigzag zksync markets. It works on both Rinkeby and Mainnet.

This market maker uses existing price feeds to set bids and asks for a market. For now, in order to provide liquidity for a market, there must be an existing market with **greater** liquidity listed on Cryptowatch, via either Uniswap or some other centralized exchange. It is crucial that the oracle market have more liquidity than the Zigzag one so that you are not prone to oracle attacks. 

Soon we will add the ability to run standalone markets and this will not be an issue. 

## Setup

Copy the `config.json.EXAMPLE` file to `config.json` to get started. 

Set your `eth_privkey` to be able to relay transactions. The ETH address with that private key should be loaded up with adequate funds for market making.

For now, you need a Cryptowatch API key to use the market maker. Once you obtain one, you can set the `cryptowatchApiKey` field in `config.json`.

To run the marketmaker:

```bash
node marketmaker.js
```

## Settings

You can add, remove, and configure pair settings in the `pairs` section. A pair setting looks like this:

```
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

There are 2 modes available with a 3rd on the way. 

* `pricefeed`: Follows an external price oracle and updates indicated bids and asks based on that. 
* `constant`: Sets an `initPrice` and market makes around that price. Can be combined with single-sided liquidity to simulate limit orders.
* `independent`: Under development. The price is set independent of a price feed. 

For all modes the `slippageRate`, `maxSize`, `minSize`, `minSpread`, and `active` settings are mandatory.

For `pricefeed` mode, the `priceFeedPrimary` is mandatory. 

For `independent` and `constant` mode, the `initPrice` is mandatory. 

The `side` setting can be toggled for single-sided liquidity. By default, the side setting is set to `d`, which stands for double-sided liquidity. To toggle single-sided liquidity, the value can be set to `b` or `s` for buy-side only or sell-side only.

The primary price feed is the price feed used to determine the bids and asks of the market maker. The secondary price feed is used to validate the first price feed and make sure the market isn't returning bad data. If the primary and secondary price feeds vary by more than 1%, the market maker will not fill orders. 

The slippage rate is the rate at which the spread increases as the base unit increases. For the example above, the spread goes up by 1e-5 for every 1 ETH in size added to an order. That's the equivalent of 0.1 bps / ETH in slippage. 

Orders coming in below the `minSpread` from the price feed will not be filled. 

A market can be set inactive by flipping the active switch to `false`. 

## Pair Setting Examples 

Stable-Stable constant price:

```
"DAI-USDC": {
    "mode": "constant",
    "initPrice": 1,
    "slippageRate": 1e-9,
    "maxSize": 100000,
    "minSize": 1,
    "minSpread": 0.0003,
    "active": true
}
```

Single-sided accumulation:

```
"ETH-USDC": {
    "mode": "pricefeed",
    "side": "b",
    "priceFeedPrimary": "cryptowatch:6631",
    "priceFeedSecondary": "cryptowatch:588",
    "slippageRate": 1e-5,
    "maxSize": 100,
    "minSize": 0.0003,
    "minSpread": 0.0005,
    "active": true
}
```

Sell the rip:

```
"DYDX-USDC": {
    "mode": "constant",
    "side": "s",
    "initPrice": 20,
    "slippageRate": 1e-5,
    "maxSize": 1000,
    "minSize": 0.5,
    "minSpread": 0,
    "active": true
}
```

## Configuration Via Environment Variables

If your hosting service requires you to pass in configs via environment variables you can compress `config.json`:

```
cat config.json | tr -d ' ' | tr -d '\n'
```

and set it to the value of the `MM_CONFIG` environment variable to override the config file.

You can also override the private key in the config file with the `ETH_PRIVKEY` environment variable, and the cryptowatch API key with the `CRYPTOWATCH_API_KEY` environment variable. 
