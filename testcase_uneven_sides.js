import * as zksync from "zksync";
import ethers from 'ethers';
import fetch from 'node-fetch';

const mmConfig = {
  "minSpread":0.1,
  "slippageRate":1e-5,
  "minSize":5,
  "maxSize":10,
  "base_active":true,
  "quote_active":true,
  "test_price":3000
}

const TEST_ID = "OZ9vgSF69jyj8--ZFUSHYTxDT07_ac1En5P2gWoS5zE"
const test_cases = [
  {
    "base":100, // 100 ETH
    "quote": 100, // 100 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s & b max"
  },
  {
    "base": 10, // 10 ETH
    "quote": 10, // 10 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s & b max"
  },
  {
    "base": 6, // 6 ETH
    "quote": 10, // 10 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s 6 & b max"
  },
  {
    "base": 10, // 10 ETH
    "quote": 6, // 6 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s max & b 6"
  },
  {
    "base": 4, // 4 ETH
    "quote": 10, // 10 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s off & b max"
  },
  {
    "base": 10, // 10 ETH
    "quote": 4, // 4 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s max & b off"
  },
  {
    "base": 0, // 0 ETH
    "quote": 10, // 10 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s off & b max"
  },
  {
    "base": 10, // 10 ETH
    "quote": 0, // 0 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s max & b off"
  },
  {
    "base": 0, // 0 ETH
    "quote": 0, // 0 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s off & b off"
  },
  {
    "base": 2, // 2 ETH
    "quote": 2, // 2 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s off & b off"
  },
  {
    "base": 100, // 100 ETH
    "quote": 100, // 100 ETH in USDC
    "base_decimals":10e18,
    "quote_decimals":10e6,
    "expected" : "s max & b max"
  }
]
const MARKETS = {};
let ethersProvider, syncProvider
run()
async function run () {
  /**************** from zigzag MM ***************/
  // Connect to zksync
  ethersProvider = ethers.getDefaultProvider("mainnet");
  syncProvider = await zksync.getDefaultProvider("mainnet");

  let activePairs = ["ETH-USDC"];
  // Get markets info
  const activePairsText = activePairs.join(',');
  const markets_url = `https://zigzag-markets.herokuapp.com/markets?chainid=${CHAIN_ID}&id=${activePairsText}`
  const markets = await fetch(markets_url).then(r => r.json());
  if (markets.error) {
      console.error(markets);
      throw new Error(markets.error);
  }

  for (let i in markets) {
      const market = markets[i];
      MARKETS[market.id] = market;
      if (market.alias) {
          MARKETS[market.alias] = market;
      }
  }

  /*****************************************/

  // run test cases
  for (let i = 0; i < test_cases.length; i++) {
    console.log("Test "+i+", Base: "+test_cases[i].base+", Quote: "+test_cases[i].quote+", expected: "+test_cases[i].expected);
    let base_test = test_cases[i].base;
    let quote_test = test_cases[i].quote * mmConfig.test_price;
    indicateLiquidity_test(TEST_ID, base_test , quote_test);
  }
}

 /* from PR only changed "const baseBalance = base_test" to fixed from zkSync pull and added console.log() */ 
function indicateLiquidity_test (market_id, base_test, quote_test) {
  const midPrice = mmConfig.test_price;
  const market = MARKETS[market_id];
  const baseCurrency = market.baseAsset;
  const quoteCurrency = market.quoteAsset;
  let baseSize = 0;
  let quoteSize = 0;
  try {
    const baseBalance = base_test
    const quoteBalance = quote_test
    console.log("baseBalance:  " + baseBalance)
    console.log("quoteBalance: " + quoteBalance)
    // limit both sides to maxSize
    baseSize = Math.min(baseBalance, mmConfig.maxSize);
    quoteSize = Math.min((quoteBalance / midPrice), mmConfig.maxSize).toFixed(baseCurrency.decimals); // use quoteSize in baseCurrency
    console.log("baseSize:  " + baseSize)
    console.log("quoteSize: " + quoteSize)
    mmConfig.base_active = (baseSize < mmConfig.minSize) ? false : true;
    mmConfig.quote_active = (quoteSize < mmConfig.minSize) ? false : true;
  } catch (e) {
      // could not get size, use generic max size
      console.log("Could not connect to zksync API to indicateLiquidity");
      baseSize = mmConfig.maxSize;
      quoteSize = mmConfig.maxSize;
  }

  const liquidity = [];
  if (mmConfig.base_active) {
    const sellPrice1 = midPrice * (1 + mmConfig.minSpread);
    const sellPrice2 = midPrice * (1 + mmConfig.minSpread + (mmConfig.slippageRate * quoteSize / 3));
    const sellPrice3 = midPrice * (1 + mmConfig.minSpread + (mmConfig.slippageRate * quoteSize * 2/3));

    liquidity.push(["s", sellPrice3, baseSize / 3]);
    liquidity.push(["s", sellPrice2, baseSize / 3]);
    liquidity.push(["s", sellPrice1, baseSize / 3]);
  }
  if (mmConfig.quote_active) {
    const buyPrice1 = midPrice * (1 - mmConfig.minSpread);
    const buyPrice2 = midPrice * (1 - mmConfig.minSpread - (mmConfig.slippageRate * baseSize / 3));
    const buyPrice3 = midPrice * (1 - mmConfig.minSpread - (mmConfig.slippageRate * baseSize * 2/3));

    liquidity.push(["b", buyPrice1, quoteSize / 3]);
    liquidity.push(["b", buyPrice2, quoteSize / 3]);
    liquidity.push(["b", buyPrice3, quoteSize / 3]);
  }

  console.log("Result:");
  console.log("base_active:  " + mmConfig.base_active);
  console.log("quote_active: " + mmConfig.quote_active);
  console.log(liquidity);
}
