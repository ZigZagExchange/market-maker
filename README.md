# Zigzag Market Maker

This is the reference market maker for Zigzag zksync markets. It works on both Rinkeby and Mainnet.

This market maker uses existing price feeds to set bids and asks for a market. For now, in order to provide liquidity for a market, there must be an existing market with **greater** liquidity listed on Cryptowatch, via either Uniswap or some other centralized exchange. It is crucial that the oracle market have more liquidity than the Zigzag one so that you are not prone to oracle attacks.

Soon we will add the ability to run standalone markets and this will not be an issue.

## Requirements

* Activated zkSync account
* Ethereum private key of that account
* Funds in that account corresponding to the pairs you want to market make
* [Cryptowatch API key](https://cryptowat.ch/account/api-access) (free for limited time)
* [Node.js](https://nodejs.org/en/download/)
* Node.js 16 works on macOS, Windows and Linux (17 seems not)
* Optional: VPS when you have high ping running the bot

## Setup

Copy the `config.json.EXAMPLE` file to `config.json` to get started.

Set your `eth_privkey` to be able to relay transactions. The ETH address with that private key should be loaded up with adequate funds for market making.

Currently zkSync needs around 5 seconds to process a single swap and generate the receipt. So  there is a upper limit of 12 swaps per wallet per minute. To circumvent this, there is also the option to use the `eth_privkeys` array. Here you can add any number of private keys. Each should be loaded up with adequate funds for market making. The founds will be handled separately, therefor each additional wallet has the opportunity to process (at least) 12 more swaps per minute.

To run the marketmaker:

```bash
node marketmaker.js
```

## Settings

#### Fee Token

With the defualt setting the bot will pay the zkSync fee wiht the same token as the user (buy currency for the bot). You can chose to override that by a fixed fee token. Check if your tokens is avalible to pay fees on zkSync [here](https://zkscan.io/explorer/tokens).

```
{
    "cryptowatchApiKey": "aaaaxxx",
    "ethPrivKeys": [
        "",
        ""
    ],    
    "zigzagChainId": 1,
    "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com",
    "feeToken": "ETH", <- add this line if you eg. want to pay the fees in Ethereum 
    "pairs": {
```

#### Mainnet zkSync
- "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com"
- "zigzagChainId": 1

#### Rinkeby zkSync
- "zigzagWsUrl": "wss://secret-thicket-93345.herokuapp.com"
- "zigzagChainId": 1000

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

A market can be set inactive by flipping the active switch to `false`.

The `side` setting can be toggled for single-sided liquidity. By default, the side setting is set to `d`, which stands for double-sided liquidity. To toggle single-sided liquidity, the value can be set to `b` or `s` for buy-side only or sell-side only.

The slippage rate is the rate at which the spread increases as the base unit increases. For the example above, the spread goes up by 1e-5 for every 1 ETH in size added to an order. That's the equivalent of 0.1 bps / ETH in slippage.

Orders coming in below the `minSpread` from the price feed will not be filled. The spread is calculated as a decimal value. 0.01 is 1%, and 0.0002 is 2 basis points (bps).


#### Price Feed

There are 3 modes available with a 4th on the way.

* `cryptowatch`: Follows an external price oracle.
* `chainlink` : Follows an external price oracle. Chainlink is WEB3 and might be slower then cryptowatch.
* `constant`: Sets an fixed price and market makes around that price. Can be combined with single-sided liquidity to simulate limit orders.
* `independent`: Under development. The price is set independent of a price feed.

**Warning:** Make sure your price feed is close to the price you see on zigzag. **Otherwise, your mm can lose money!**

For all modes the `slippageRate`, `maxSize`, `minSize`, `minSpread`, and `active` settings are mandatory.

The primary price feed is the price feed used to determine the bids and asks of the market maker. The secondary price feed is used to validate the first price feed and make sure the market isn't returning bad data. If the primary and secondary price feeds vary by more than 3%, the market maker will not fill orders.

###### Cryptowatch
You need a Cryptowatch API key to use the market maker. Once you obtain one, you can set the `cryptowatchApiKey` field in `config.json`. And set it to your public key.

You can use [this link](https://api.cryptowat.ch/markets) to download a JSON with all available market endpoints. Add those to you pair config as "cryptowatch:<id>".

Example:
```
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "cryptowatch:6631",
    "priceFeedSecondary": "cryptowatch:588",
    ....
}
```

###### Chainlink
With chainlink you have access to price oracles via blockchain. The requests are read-calls to a smart contract. The public ethers provider might be too slow for a higher number of pairs or at times of high demand. Therefore, it might be needed to have access to an Infura account (100000 Requests/Day for free). You can get an endpoint for your market maker (like https://mainnet.infura.io/v3/...), You can add this with the `infuraUrl` field in `config.json`, like this:
```

"infuraUrl": "https://mainnet.infura.io/v3/xxxxxxxx",
"pairs": {
  "ETH-USDC": {
      "zigzagChainId": 1,
      "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com",
      ....
  }
```
You can get the available market contracts [here.](https://docs.chain.link/docs/ethereum-addresses/)Add those to you pair config as "chainlink:<address>", like this:
```
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "chainlink:0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "priceFeedSecondary": null,
    ....
}
```

###### UniswapV3
With uniswapV3 you have access to price feed's via blockchain. The requests are read-calls to a smart contract. The public ethers provider might be too slow for a higher number of pairs or at times of high demand. Therefore, it might be needed to have access to an Infura account (100000 Requests/Day for free). You can get an endpoint for your market maker (like https://mainnet.infura.io/v3/...), You can add this with the `infuraUrl` field in `config.json`, like this:
```
"infuraUrl": "https://mainnet.infura.io/v3/xxxxxxxx",
"pairs": {
  "ETH-USDC": {
      "zigzagChainId": 1,
      "zigzagWsUrl": "wss://zigzag-exchange.herokuapp.com",
      ....
  }
```
You can get the available market contracts [here.](https://info.uniswap.org) Select a token and then a pool matching the pair you plan to market make. Make sure base and quote tokens match (USDC-ETH don't work for ETH-USDC). After selecting a pool, you can see the adress in the browser URL. Add that to your pair config as "uniswapv3:<address>", like this:
```
"ETH-USDC": {
    "side": "d",
    "priceFeedPrimary": "uniswapv3:0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    "priceFeedSecondary": null,
    ....
}
```

###### Constant
With constant mode, you can set a fixed price to market make. The bot will not change that price. Any secondary price feed will be ignored, if used as priceFeedPrimary. Also good as a `priceFeedSecondary` on stablecoins.

```
"DAI-USDC": {
    "side": "d",
    "priceFeedPrimary": "constant:1",
    "priceFeedSecondary": null,
    ....
}
```

## Pair Options

These pair options can be set for each pair individual. You can even use more then on option per pair (though they might cancel each other out).

###### delayAfterFill
The market maker will stop market making on the pair, after successfully filling an order. This can be used to wait out bigger price moves. 
With the second parameter, you can set the minimum trade size (**in base quantity**) to activate the option. This parameter is optional and can be omitted (like: `[60]`)

Example, here a delay of **60 seconds** is used:
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
    "active": true,
    "delayAfterFill": [60, 0.5]        <- This would pause the pair for 60 sec after a fill.
}
```

###### increaseSpreadAfterFill
The market maker increases the spread by the set amount. After the time (**in seconds**) the spread will fall back to the old value. This can happen multiple times in case the mm fills again in the set time (e.g. 0.1 -> 0.2 -> 0.3). 
With the third parameter, you can set the minimum trade size (**in base quantity**) to activate the option. This parameter is optional and can be omitted.
Example:
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
    "active": true,
    "increaseSpreadAfterFill": [0.1, 300, 0.5]        <- This would increase the minSpread by 0.1 per fill for 300 sec each.
}
```

###### changeSizeAfterFill
The market maker increases the size (**in base token**) by the set amount. After the time (**in seconds**) the size will fall back to the old value. This can happen multiple times in case the mm fills again in the set time (e.g. 0.1 -> 0.2 -> 0.3). You can set a value below 0 to reduce size after fill (like: [-0.1, 300]). 
With the third parameter, you can set the minimum trade size (**in base quantity**) to activate the option. This parameter is optional and can be omitted.
Example:
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
    "active": true,
    "changeSizeAfterFill": [0.05, 300, 0.5]        <- This would increase the maxSize by 0.05 ETH (base token) per fill for 300 sec each.
}
```

###### numOrdersIndicated
On the UI, when indicating liquidity, by default will indicate the liquidity in 10 separate orders spaced evenly apart. To change the number of orders indicated, you can use the `numOrdersIndicated` setting.

Example:
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
    "active": true,
    "numOrdersIndicated": 5
}
```

## Pair Setting Examples

Stable-Stable constant price:

```
"DAI-USDC": {
    "priceFeedPrimary": "constant:1",
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
    "priceFeedPrimary": "constant:20",
    "side": "s",
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

You can also override the private key in the config file with the `ETH_PRIVKEY` environment variable, and the cryptowatch API key with the `CRYPTOWATCH_API_KEY` environment variable, and the Infura provider url with `INFURA_URL`
