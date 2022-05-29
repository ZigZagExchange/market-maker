import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';

dotenv.config();

// Globals
const PRICE_FEEDS = {};
const OPEN_ORDERS = {};
const NONCES = {};
const WALLETS = {};
const MARKETS = {};
const CHAINLINK_PROVIDERS = {};
const UNISWAP_V3_PROVIDERS = {};
const PAST_ORDER_LIST = {};
const FEE_TOKEN_LIST = [];
let FEE_TOKEN = null;

let uniswap_error_counter = 0;
let chainlink_error_counter = 0;

// Load MM config
let MM_CONFIG;
if (process.env.MM_CONFIG) {
    MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
}
else {
    const mmConfigFile = fs.readFileSync("config.json", "utf8");
    MM_CONFIG = JSON.parse(mmConfigFile);
}
if (MM_CONFIG.feeToken) {
  FEE_TOKEN = MM_CONFIG.feeToken;
}
let activePairs = [];
for (let marketId in MM_CONFIG.pairs) {
    const pair = MM_CONFIG.pairs[marketId];
    if (pair.active) {
        activePairs.push(marketId);
    }
}
console.log("ACTIVE PAIRS", activePairs);

// Connect to zksync
const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
const ETH_NETWORK = (CHAIN_ID === 1) ? "mainnet" : "rinkeby";
let ethersProvider;
const providerUrl = (process.env.INFURA_URL || MM_CONFIG.infuraUrl);
if(providerUrl && ETH_NETWORK=="mainnet") {
    ethersProvider = ethers.getDefaultProvider(providerUrl);
} else {
    ethersProvider = ethers.getDefaultProvider(ETH_NETWORK);
}

// Start price feeds
await setupPriceFeeds();

let syncProvider;
try {
    syncProvider = await zksync.getDefaultProvider(ETH_NETWORK);
    const keys = [];
    const ethPrivKey = (process.env.ETH_PRIVKEY || MM_CONFIG.ethPrivKey);
    if(ethPrivKey && ethPrivKey != "") { keys.push(ethPrivKey);  }
    let ethPrivKeys;
    if (process.env.ETH_PRIVKEYS) {
        ethPrivKeys = JSON.parse(process.env.ETH_PRIVKEYS);
    }
    else {
        ethPrivKeys = MM_CONFIG.ethPrivKeys;
    }
    if(ethPrivKeys && ethPrivKeys.length > 0) {
        ethPrivKeys.forEach( key => {
            if(key != "" && !keys.includes(key)) {
                keys.push(key);
            }
        });
    }
    for(let i=0; i<keys.length; i++) {
        let ethWallet = new ethers.Wallet(keys[i]);
        let syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
        if (!(await syncWallet.isSigningKeySet())) {
            console.log("setting sign key");
            const signKeyResult = await syncWallet.setSigningKey({
                feeToken: "ETH",
                ethAuthType: "ECDSA",
            });
            console.log(signKeyResult);
        }
        let accountId = await syncWallet.getAccountId();
        let account_state = await syncWallet.getAccountState();
        WALLETS[accountId] = {
            'ethWallet': ethWallet,
            'syncWallet': syncWallet,
            'account_state': account_state,
            'ORDER_BROADCASTING': false,
        }
    }
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

// Update account state loop
setInterval(updateAccountState, 900000);

let fillOrdersInterval, indicateLiquidityInterval;
let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on('open', onWsOpen);
zigzagws.on('close', onWsClose);
zigzagws.on('error', console.error);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    fillOrdersInterval = setInterval(fillOpenOrders, 200);
    indicateLiquidityInterval = setInterval(indicateLiquidity, 12500);
    for (let market in MM_CONFIG.pairs) {
        if (MM_CONFIG.pairs[market].active) {
            const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
            zigzagws.send(JSON.stringify(msg));
        }
    }
}

function onWsClose () {
    console.log("Websocket closed. Restarting");
    setTimeout(() => {
        clearInterval(fillOrdersInterval)
        clearInterval(indicateLiquidityInterval)
        zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('close', onWsClose);
        zigzagws.on('error', console.error);
    }, 5000);
}

async function handleMessage(json) {
    const msg = JSON.parse(json);
    if (!(["lastprice", "liquidity2", "fillstatus", "marketinfo"]).includes(msg.op)) console.log(json.toString());
    switch(msg.op) {
        case 'error':
            const accountId = msg.args?.[1];
            if(msg.args[0] == 'fillrequest' && accountId) {
                WALLETS[accountId]['ORDER_BROADCASTING'] = false;
            }         
            break;
        case 'orders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderId = order[1];
                const fillable = isOrderFillable(order);
                console.log(fillable);
                if (fillable.fillable) {
                    sendFillRequest(order, fillable.walletId);
                } else if ([
                  "sending order already",
                  "badprice"
                ].includes(fillable.reason)) {
                    OPEN_ORDERS[orderId] = order;
                }
            });
            break
        case "userordermatch":
            const chainId = msg.args[0];
            const orderId = msg.args[1];
            const fillOrder = msg.args[3];
            const wallet = WALLETS[fillOrder.accountId];
            if(!wallet) {
                console.error("No wallet with this accountId: "+fillOrder.accountId);
                break
            } else {
                try {
                    await broadcastFill(chainId, orderId, msg.args[2], fillOrder, wallet);
                } catch (e) {
                    const orderCommitMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,'r',null,e.message]]]}
                    zigzagws.send(JSON.stringify(orderCommitMsg));
                    console.error(e);
                }
                wallet['ORDER_BROADCASTING'] = false;
            }
            break
        case "marketinfo":
            const marketInfo = msg.args[0];
            const marketId  = marketInfo.alias;
            if(!marketId) break
            let oldBaseFee = "N/A", oldQuoteFee = "N/A";
            try {
                oldBaseFee = MARKETS[marketId].baseFee;
                oldQuoteFee = MARKETS[marketId].quoteFee;
            } catch (e) {
                // pass, no old marketInfo
            }
            MARKETS[marketId] = marketInfo;
            const newBaseFee = MARKETS[marketId].baseFee;
            const newQuoteFee = MARKETS[marketId].quoteFee;
            console.log(`marketinfo ${marketId} - update baseFee ${oldBaseFee} -> ${newBaseFee}, quoteFee ${oldQuoteFee} -> ${newQuoteFee}`);
            if (FEE_TOKEN) break
            if(
              marketInfo.baseAsset.enabledForFees &&
              !FEE_TOKEN_LIST.includes(marketInfo.baseAsset.id)
            ) {
              FEE_TOKEN_LIST.push(marketInfo.baseAsset.id);
            } 
            if(
              marketInfo.quoteAsset.enabledForFees &&
              !FEE_TOKEN_LIST.includes(marketInfo.quoteAsset.id)
            ) {
              FEE_TOKEN_LIST.push(marketInfo.quoteAsset.id);
            } 
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainId = order[0];
    const marketId = order[2];
    const market = MARKETS[marketId];
    const mmConfig = MM_CONFIG.pairs[marketId];
    const mmSide = (mmConfig.side) ? mmConfig.side : 'd';
    if (chainId != CHAIN_ID) return { fillable: false, reason: "badchain" }
    if (!market) return { fillable: false, reason: "badmarket" }
    if (!mmConfig.active) return { fillable: false, reason: "inactivemarket" }

    const baseQuantity = order[5];
    const quoteQuantity = order[6];
    const expires = order[7];
    const side = order[3];
    const price = order[4];
    
    const now = Date.now() / 1000 | 0;

    if (now > expires) {
        return { fillable: false, reason: "expired" };
    }

    if (mmSide !== 'd' && mmSide == side) {
        return { fillable: false, reason: "badside" };
    }

    if (baseQuantity < mmConfig.minSize) {
        return { fillable: false, reason: "badsize" };
    }
    else if (baseQuantity > mmConfig.maxSize) {
        return { fillable: false, reason: "badsize" };
    }

    let quote;
    try {
      quote = genQuote(chainId, marketId, side, baseQuantity);      
    } catch (e) {
        return { fillable: false, reason: e.message }
    }
    if (side == 's' && price > quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }
    else if (side == 'b' && price < quote.quotePrice) {
        return { fillable: false, reason: "badprice" };
    }

    const sellCurrency = (side === 's') ? market.quoteAsset.symbol : market.baseAsset.symbol;
    const sellDecimals = (side === 's') ? market.quoteAsset.decimals : market.baseAsset.decimals;
    const sellQuantity = (side === 's') ? quote.quoteQuantity : baseQuantity;
    const neededBalanceBN = sellQuantity * 10**sellDecimals;
    let goodWalletIds = [];
    Object.keys(WALLETS).forEach(accountId => {
        const walletBalance = WALLETS[accountId]['account_state'].committed.balances[sellCurrency];
        if (Number(walletBalance) > (neededBalanceBN * 1.05)) {
            goodWalletIds.push(accountId);
        }
    });

    if (goodWalletIds.length === 0) {
        return { fillable: false, reason: "badbalance" };
    }

    goodWalletIds = goodWalletIds.filter(accountId => {
        return !WALLETS[accountId]['ORDER_BROADCASTING'];
    });

    if (goodWalletIds.length === 0) {
        return { fillable: false, reason: "sending order already" };
    }

    return { fillable: true, reason: null, walletId: goodWalletIds[0]};
}

function genQuote(chainId, marketId, side, baseQuantity) {
  const market = MARKETS[marketId];
  if (CHAIN_ID !== chainId) throw new Error("badchain");
  if (!market) throw new Error("badmarket");
  if (!(['b','s']).includes(side)) throw new Error("badside");
  if (baseQuantity <= 0) throw new Error("badquantity");

  validatePriceFeed(marketId);

  const mmConfig = MM_CONFIG.pairs[marketId];
  const mmSide = mmConfig.side || 'd';
  if (mmSide !== 'd' && mmSide === side) {
      throw new Error("badside");
  }
  const primaryPrice = PRICE_FEEDS[mmConfig.priceFeedPrimary];
  if (!primaryPrice) throw new Error("badprice");
  const SPREAD = mmConfig.minSpread + (baseQuantity * mmConfig.slippageRate);
  let quoteQuantity;
  if (side === 'b') {
      quoteQuantity = (baseQuantity * primaryPrice * (1 + SPREAD)) + market.quoteFee;
  }
  else if (side === 's') {
      quoteQuantity = (baseQuantity - market.baseFee) * primaryPrice * (1 - SPREAD);
  }
  const quotePrice = Number((quoteQuantity / baseQuantity).toPrecision(6));
  if (quotePrice < 0) throw new Error("Amount is inadequate to pay fee");
  if (isNaN(quotePrice)) throw new Error("Internal Error. No price generated.");
  return { quotePrice, quoteQuantity };
}

function validatePriceFeed(marketId) {
    const mmConfig = MM_CONFIG.pairs[marketId];
    const primaryPriceFeedId = mmConfig.priceFeedPrimary;
    const secondaryPriceFeedId = mmConfig.priceFeedSecondary;

    // Constant mode checks    
    const [mode, price] = primaryPriceFeedId.split(':');
    if (mode === "constant") {
        if (price > 0) return true;
        else throw new Error("No initPrice available");
    }

    // Check if primary price exists
    const primaryPrice = PRICE_FEEDS[primaryPriceFeedId];
    if (!primaryPrice) throw new Error("Primary price feed unavailable");


    // If there is no secondary price feed, the price auto-validates
    if (!secondaryPriceFeedId) return true;

    // Check if secondary price exists
    const secondaryPrice = PRICE_FEEDS[secondaryPriceFeedId];
    if (!secondaryPrice) throw new Error("Secondary price feed unavailable");

    // If the secondary price feed varies from the primary price feed by more than 1%, assume something is broken
    const percentDiff = Math.abs(primaryPrice - secondaryPrice) / primaryPrice;
    if (percentDiff > 0.03) {
      console.error("Primary and secondary price feeds do not match!");
      throw new Error("Circuit breaker triggered");
    }

    return true;
}

async function sendFillRequest(orderreceipt, accountId) {
  const chainId = orderreceipt[0];
  const orderId = orderreceipt[1];
  const marketId = orderreceipt[2];
  const market = MARKETS[marketId];
  const baseCurrency = market.baseAssetId;
  const quoteCurrency = market.quoteAssetId;
  const side = orderreceipt[3];
  const baseQuantity = orderreceipt[5];
  const quoteQuantity = orderreceipt[6];
  const quote = genQuote(chainId, marketId, side, baseQuantity);
  let tokenSell, tokenBuy, sellQuantity, buyQuantity, buySymbol, sellSymbol;
  if (side === "b") {
      tokenSell = market.baseAssetId;
      tokenBuy = market.quoteAssetId;

      sellSymbol = market.baseAsset.symbol;
      buySymbol = market.quoteAsset.symbol;
      // Add 1 bip to to protect against rounding errors
      sellQuantity = (baseQuantity * 1.0001).toFixed(market.baseAsset.decimals);
      buyQuantity = (quote.quoteQuantity * 0.9999).toFixed(market.quoteAsset.decimals);
  } else if (side === "s") {
      tokenSell = market.quoteAssetId;
      tokenBuy = market.baseAssetId;

      sellSymbol = market.quoteAsset.symbol;
      buySymbol = market.baseAsset.symbol;
      // Add 1 bip to to protect against rounding errors
      sellQuantity = (quote.quoteQuantity * 1.0001).toFixed(market.quoteAsset.decimals);
      buyQuantity = (baseQuantity * 0.9999).toFixed(market.baseAsset.decimals);
  }
  const sellQuantityParsed = syncProvider.tokenSet.parseToken(
      tokenSell,
      sellQuantity
  );
  const sellQuantityPacked = zksync.utils.closestPackableTransactionAmount(sellQuantityParsed);
  const tokenRatio = {};
  tokenRatio[tokenBuy] = buyQuantity;
  tokenRatio[tokenSell] = sellQuantity;
  const oneMinExpiry = (Date.now() / 1000 | 0) + 60;
  const orderDetails = {
      tokenSell,
      tokenBuy,
      amount: sellQuantityPacked,
      ratio: zksync.utils.tokenRatio(tokenRatio),
      validUntil: oneMinExpiry
  }
  const fillOrder = await WALLETS[accountId].syncWallet.getOrder(orderDetails);

  // Set wallet flag
  WALLETS[accountId]['ORDER_BROADCASTING'] = true;

  // ORDER_BROADCASTING should not take longer as 5 sec
  setTimeout(function() {
      WALLETS[accountId]['ORDER_BROADCASTING'] = false;
  }, 5000);

  const resp = { op: "fillrequest", args: [chainId, orderId, fillOrder] };
  zigzagws.send(JSON.stringify(resp));
  rememberOrder(chainId,
      marketId,
      orderId, 
      quote.quotePrice, 
      sellSymbol,
      sellQuantity,
      buySymbol,
      buyQuantity
  );
}

async function broadcastFill(chainId, orderId, swapOffer, fillOrder, wallet) {
    // Nonce check
    const nonce = swapOffer.nonce;
    const userNonce = NONCES[swapOffer.accountId];
    if (nonce <= userNonce) {
        const orderCommitMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,'r',null,"Order failed userNonce check."]]]}
        zigzagws.send(JSON.stringify(orderCommitMsg));
        return;
    }
    // select token to match user's fee token
    let feeToken;
    if (FEE_TOKEN) {
      feeToken = FEE_TOKEN
    } else {
      feeToken = (FEE_TOKEN_LIST.includes(swapOffer.tokenSell))
      ? swapOffer.tokenSell
      : 'ETH'
    }
    
    const randInt = (Math.random()*1000).toFixed(0);
    console.time('syncswap' + randInt);
    const swap = await wallet['syncWallet'].syncSwap({
        orders: [swapOffer, fillOrder],
        feeToken: feeToken,
        nonce: fillOrder.nonce
    });
    const txHash = swap.txHash.split(":")[1];
    const txHashMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,'b',txHash]]]}
    zigzagws.send(JSON.stringify(txHashMsg));
    console.timeEnd('syncswap' + randInt);

    console.time('receipt' + randInt);
    let receipt, success = false;
    try {
        receipt = await swap.awaitReceipt();
        if (receipt.success) {
            success = true;
            NONCES[swapOffer.accountId] = swapOffer.nonce;
        }
    } catch (e) {
        receipt = null;
        success = false;
    }
    console.timeEnd('receipt' + randInt);
    console.log("Swap broadcast result", {swap, receipt});

    let newStatus, error;
    if(success) {
        afterFill(chainId, orderId, wallet);
        newStatus = 'f';
        error = null;
   } else {
        newStatus = 'r';
        error = swap.error.toString();
   }

    const orderCommitMsg = {op:"orderstatusupdate", args:[[[chainId,orderId,newStatus,txHash,error]]]}
    zigzagws.send(JSON.stringify(orderCommitMsg));
}

async function fillOpenOrders() {
    for (let orderId in OPEN_ORDERS) {
        const order = OPEN_ORDERS[orderId];
        const fillable = isOrderFillable(order);
        if (fillable.fillable) {
            sendFillRequest(order, fillable.walletId);
            delete OPEN_ORDERS[orderId];
        }else if (![
            "sending order already",
            "badprice"
          ].includes(fillable.reason)) {
            delete OPEN_ORDERS[orderId];
        }
    }
}

async function setupPriceFeeds() {
  const cryptowatch = [], chainlink = [], uniswapV3 = [];
    for (let market in MM_CONFIG.pairs) {
        const pairConfig = MM_CONFIG.pairs[market];
        if(!pairConfig.active) { continue; }
        // This is needed to make the price feed backwards compatalbe with old constant mode:
        // "DYDX-USDC": {
        //      "mode": "constant",
        //      "initPrice": 20,    
        if(pairConfig.mode == "constant") {
            const initPrice = pairConfig.initPrice;
            pairConfig['priceFeedPrimary'] = "constant:" + initPrice.toString();
        }
        const primaryPriceFeed = pairConfig.priceFeedPrimary;
        const secondaryPriceFeed = pairConfig.priceFeedSecondary;

        // parse keys to lower case to match later PRICE_FEED keys
        if (primaryPriceFeed) {
          MM_CONFIG.pairs[market].priceFeedPrimary = primaryPriceFeed.toLowerCase();
        }
        if (secondaryPriceFeed) {
          MM_CONFIG.pairs[market].priceFeedSecondary = secondaryPriceFeed.toLowerCase();
        }
        [primaryPriceFeed, secondaryPriceFeed].forEach(priceFeed => {
            if(!priceFeed) { return; }
            const [provider, id] = priceFeed.split(':');
            switch(provider.toLowerCase()) {
                case 'cryptowatch':
                    if(!cryptowatch.includes(id)) { cryptowatch.push(id); }
                    break;
                case 'chainlink':
                    if(!chainlink.includes(id)) { chainlink.push(id); }
                    break;
                case 'uniswapv3':
                    if(!uniswapV3.includes(id)) { uniswapV3.push(id); }
                    break;
                case 'constant':
                    PRICE_FEEDS['constant:'+id] = parseFloat(id);
                    break;
                default:
                    throw new Error("Price feed provider "+provider+" is not available.")
                    break;
          }
      });
  }
  if(chainlink.length > 0) await chainlinkSetup(chainlink);
  if(cryptowatch.length > 0) await cryptowatchWsSetup(cryptowatch);
  if(uniswapV3.length > 0) await uniswapV3Setup(uniswapV3);

  console.log(PRICE_FEEDS);
}

async function cryptowatchWsSetup(cryptowatchMarketIds) {
    // Set initial prices
    const cryptowatchApiKey = process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey;
    const cryptowatchMarkets = await fetch("https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey).then(r => r.json());
    const cryptowatchMarketPrices = await fetch("https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey).then(r => r.json());
    for (let i in cryptowatchMarketIds) {
        const cryptowatchMarketId = cryptowatchMarketIds[i];
        try {
            const cryptowatchMarket = cryptowatchMarkets.result.find(row => row.id == cryptowatchMarketId);
            const exchange = cryptowatchMarket.exchange;
            const pair = cryptowatchMarket.pair;
            const key = `market:${exchange}:${pair}`;
            PRICE_FEEDS['cryptowatch:'+cryptowatchMarketIds[i]] = cryptowatchMarketPrices.result[key];
        } catch (e) {
            console.error("Could not set price feed for cryptowatch:" + cryptowatchMarketId);
        }
    }

    const subscriptionMsg = {
        "subscribe": {
            "subscriptions": []
        }
    }
    for (let i in cryptowatchMarketIds) {
        const cryptowatchMarketId = cryptowatchMarketIds[i];

        // first get initial price info

        subscriptionMsg.subscribe.subscriptions.push({
            "streamSubscription": {
                "resource": `markets:${cryptowatchMarketId}:book:spread`
            }
        })
    }
    let cryptowatch_ws = new WebSocket("wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey);
    cryptowatch_ws.on('open', onopen);
    cryptowatch_ws.on('message', onmessage);
    cryptowatch_ws.on('close', onclose);
    cryptowatch_ws.on('error', console.error);

    function onopen() {
        cryptowatch_ws.send(JSON.stringify(subscriptionMsg));
    }
    function onmessage (data) {
        const msg = JSON.parse(data);
        if (!msg.marketUpdate) return;

        const marketId = "cryptowatch:" + msg.marketUpdate.market.marketId;
        let ask = msg.marketUpdate.orderBookSpreadUpdate.ask.priceStr;
        let bid = msg.marketUpdate.orderBookSpreadUpdate.bid.priceStr;
        let price = ask / 2 + bid / 2;
        PRICE_FEEDS[marketId] = price;
    }
    function onclose () {
        setTimeout(cryptowatchWsSetup, 5000, cryptowatchMarketIds);
    }
}

async function chainlinkSetup(chainlinkMarketAddress) {
    const results = chainlinkMarketAddress.map(async (address) => {
        try {
            const aggregatorV3InterfaceABI = JSON.parse(fs.readFileSync('ABIs/chainlinkV3InterfaceABI.abi'));
            const provider = new ethers.Contract(address, aggregatorV3InterfaceABI, ethersProvider);
            const decimals = await provider.decimals();
            const key = 'chainlink:' + address;
            CHAINLINK_PROVIDERS[key] = [provider, decimals];

            // get inital price
            const response = await provider.latestRoundData();
            PRICE_FEEDS[key] = parseFloat(response.answer) / 10**decimals;
        } catch (e) {
            throw new Error ("Error while setting up chainlink for "+address+", Error: "+e);
        }
    });
    await Promise.all(results);
    setInterval(chainlinkUpdate, 30000);
}

async function chainlinkUpdate() {
    try {
        await Promise.all(Object.keys(CHAINLINK_PROVIDERS).map(async (key) => {
            const [provider, decimals] = CHAINLINK_PROVIDERS[key];
            const response = await provider.latestRoundData();
            PRICE_FEEDS[key] = parseFloat(response.answer) / 10**decimals;
        }));
        chainlink_error_counter = 0;
    } catch (err) {
        chainlink_error_counter += 1;
        console.log(`Failed to update chainlink, retry: ${err.message}`);
        if(chainlink_error_counter > 4) {
            throw new Error ("Failed to update chainlink since 150 seconds!")
        }
    }
}

async function uniswapV3Setup(uniswapV3Address) {
    const results = uniswapV3Address.map(async (address) => {
        try {
            const IUniswapV3PoolABI = JSON.parse(fs.readFileSync('ABIs/IUniswapV3Pool.abi'));
            const ERC20ABI = JSON.parse(fs.readFileSync('ABIs/ERC20.abi'));
  
            const provider = new ethers.Contract(address, IUniswapV3PoolABI, ethersProvider);
            
            let [
              slot0,
              addressToken0,
              addressToken1
            ] = await Promise.all ([
              provider.slot0(),
              provider.token0(),
              provider.token1()
            ]);
  
            const tokenProvier0 = new ethers.Contract(addressToken0, ERC20ABI, ethersProvider);
            const tokenProvier1 = new ethers.Contract(addressToken1, ERC20ABI, ethersProvider);
  
            let [
              decimals0,
              decimals1
            ] = await Promise.all ([
              tokenProvier0.decimals(),
              tokenProvier1.decimals()
            ]);
  
            const key = 'uniswapv3:' + address;
            const decimalsRatio = (10**decimals0 / 10**decimals1);  
            UNISWAP_V3_PROVIDERS[key] = [provider, decimalsRatio];

            // get inital price
            const price = (slot0.sqrtPriceX96*slot0.sqrtPriceX96*decimalsRatio) / (2**192);
            PRICE_FEEDS[key] = price;
        } catch (e) {
            throw new Error ("Error while setting up uniswapV3 for "+address+", Error: "+e);
        }
    });
    await Promise.all(results);
    setInterval(uniswapV3Update, 30000);
}

async function uniswapV3Update() {
    try {
        await Promise.all(Object.keys(UNISWAP_V3_PROVIDERS).map(async (key) => {
            const [provider, decimalsRatio] = UNISWAP_V3_PROVIDERS[key];
            const slot0 = await provider.slot0();
            PRICE_FEEDS[key] = (slot0.sqrtPriceX96*slot0.sqrtPriceX96*decimalsRatio) / (2**192);
        }));
        // reset error counter if successful 
        uniswap_error_counter = 0;
    } catch (err) {
        uniswap_error_counter += 1;
        console.log(`Failed to update uniswap, retry: ${err.message}`);
        console.log(err.message);
        if(uniswap_error_counter > 4) {
            throw new Error ("Failed to update uniswap since 150 seconds!")
        }
    }
}

function indicateLiquidity (pairs = MM_CONFIG.pairs) {
    for(const marketId in pairs) {
        const mmConfig = pairs[marketId];
        if(!mmConfig || !mmConfig.active) continue;

        try {
            validatePriceFeed(marketId);
        } catch(e) {
            console.error("Can not indicateLiquidity ("+marketId+") because: " + e);
            continue;
        }

        const marketInfo = MARKETS[marketId];
        if (!marketInfo) continue;

        const midPrice = PRICE_FEEDS[mmConfig.priceFeedPrimary];
        if (!midPrice) continue;

        const expires = (Date.now() / 1000 | 0) + 10; // 10s expiry
        const side = mmConfig.side || 'd';

        let maxBaseBalance = 0, maxQuoteBalance = 0;
        Object.keys(WALLETS).forEach(accountId => {
            const walletBase = WALLETS[accountId]['account_state'].committed.balances[marketInfo.baseAsset.symbol];
            const walletQuote = WALLETS[accountId]['account_state'].committed.balances[marketInfo.quoteAsset.symbol];
            if (Number(walletBase) > maxBaseBalance) {
                maxBaseBalance = walletBase;
            }
            if (Number(walletQuote) > maxQuoteBalance) {
                maxQuoteBalance = walletQuote;
            }
        });
        const baseBalance = maxBaseBalance / 10**marketInfo.baseAsset.decimals;
        const quoteBalance = maxQuoteBalance / 10**marketInfo.quoteAsset.decimals;
        const maxSellSize = Math.min(baseBalance, mmConfig.maxSize);
        const maxBuySize = Math.min(quoteBalance / midPrice, mmConfig.maxSize);

        // dont do splits if under 1000 USD
        const usdBaseBalance = baseBalance * marketInfo.baseAsset.usdPrice;
        const usdQuoteBalance = quoteBalance * marketInfo.quoteAsset.usdPrice;
        let buySplits = (usdQuoteBalance < 1000) ? 1 : (mmConfig.numOrdersIndicated || 4);
        let sellSplits = (usdBaseBalance < 1000) ? 1 : (mmConfig.numOrdersIndicated || 4);
        
        if (usdQuoteBalance < (10 * buySplits)) buySplits = Math.floor(usdQuoteBalance / 10)
        if (usdBaseBalance < (10 * sellSplits)) sellSplits = Math.floor(usdBaseBalance / 10)
        
        const liquidity = [];
        for (let i=1; i <= buySplits; i++) {
            const buyPrice = midPrice * (1 - mmConfig.minSpread - (mmConfig.slippageRate * maxBuySize * i/buySplits));
            if ((['b','d']).includes(side)) {
                liquidity.push(["b", buyPrice, maxBuySize / buySplits, expires]);
            }
        }
        for (let i=1; i <= sellSplits; i++) {
          const sellPrice = midPrice * (1 + mmConfig.minSpread + (mmConfig.slippageRate * maxSellSize * i/sellSplits));
          if ((['s','d']).includes(side)) {
              liquidity.push(["s", sellPrice, maxSellSize / sellSplits, expires]);
          }
      }

        const msg = { op: "indicateliq2", args: [CHAIN_ID, marketId, liquidity] };
        try {
            zigzagws.send(JSON.stringify(msg));
        } catch (e) {
            console.error("Could not send liquidity");
            console.error(e);
        }
    }
}

function cancelLiquidity (chainId, marketId) {
    const msg = { op: "indicateliq2", args: [chainId, marketId, []] };
    try {
        zigzagws.send(JSON.stringify(msg));
    } catch (e) {
        console.error("Could not send liquidity");
        console.error(e);
    }
}

async function afterFill(chainId, orderId, wallet) {
    const order = PAST_ORDER_LIST[orderId];
    if(!order) { return; }
    const marketId = order.marketId;
    const mmConfig = MM_CONFIG.pairs[marketId];
    if(!mmConfig) { return; }

    // update account state from order
    const account_state = wallet['account_state'].committed.balances;
    const buyTokenParsed = syncProvider.tokenSet.parseToken (
        order.buySymbol,
        order.buyQuantity
    );
    const sellTokenParsed = syncProvider.tokenSet.parseToken (
        order.sellSymbol,
        order.sellQuantity
    );
    const oldBuyBalance = account_state[order.buySymbol] ? account_state[order.buySymbol] : '0';
    const oldSellBalance = account_state[order.sellSymbol] ? account_state[order.sellSymbol] : '0';
    const oldBuyTokenParsed = ethers.BigNumber.from(oldBuyBalance);
    const oldSellTokenParsed = ethers.BigNumber.from(oldSellBalance);
    account_state[order.buySymbol] = (oldBuyTokenParsed.add(buyTokenParsed)).toString();
    account_state[order.sellSymbol] = (oldSellTokenParsed.sub(sellTokenParsed)).toString();
    
    const indicateMarket = {};
    indicateMarket[marketId] = mmConfig;
    if(mmConfig.delayAfterFill) {
        let delayAfterFillMinSize
        if(
            !Array.isArray(mmConfig.delayAfterFill) ||
            !mmConfig.delayAfterFill[1]
        ) {
            delayAfterFillMinSize = 0;
        } else {
            delayAfterFillMinSize = mmConfig.delayAfterFill[1]
        }

        if(order.baseQuantity > delayAfterFillMinSize)  {
            // no array -> old config
            // or array and buyQuantity over minSize
            mmConfig.active = false;
            cancelLiquidity (chainId, marketId);
            console.log(`Set ${marketId} passive for ${mmConfig.delayAfterFill} seconds.`);
            setTimeout(() => {
                mmConfig.active = true;
                console.log(`Set ${marketId} active.`);
                indicateLiquidity(indicateMarket);
            }, mmConfig.delayAfterFill * 1000);   
        }             
    }

    // increaseSpreadAfterFill size might not be set
    const increaseSpreadAfterFillMinSize = (mmConfig.increaseSpreadAfterFill?.[2]) 
        ? mmConfig.increaseSpreadAfterFill[2]
        : 0
    if(
        mmConfig.increaseSpreadAfterFill &&
        order.baseQuantity > increaseSpreadAfterFillMinSize
        
    ) {
        const [spread, time] = mmConfig.increaseSpreadAfterFill;
        mmConfig.minSpread = mmConfig.minSpread + spread;
        console.log(`Changed ${marketId} minSpread by ${spread}.`);
        indicateLiquidity(indicateMarket);
        setTimeout(() => {
            mmConfig.minSpread = mmConfig.minSpread - spread;
            console.log(`Changed ${marketId} minSpread by -${spread}.`);
            indicateLiquidity(indicateMarket);
        }, time * 1000);
    }

    // changeSizeAfterFill size might not be set
    const changeSizeAfterFillMinSize = (mmConfig.changeSizeAfterFill?.[2]) 
        ? mmConfig.changeSizeAfterFill[2]
        : 0
    if(
        mmConfig.changeSizeAfterFill &&
        order.baseQuantity > changeSizeAfterFillMinSize
    ) {
        const [size, time] = mmConfig.changeSizeAfterFill;
        mmConfig.maxSize = mmConfig.maxSize + size;
        console.log(`Changed ${marketId} maxSize by ${size}.`);
        indicateLiquidity(indicateMarket);
        setTimeout(() => {
            mmConfig.maxSize = mmConfig.maxSize - size;
            console.log(`Changed ${marketId} maxSize by ${(size* (-1))}.`);
            indicateLiquidity(indicateMarket);
        }, time * 1000);
    }
}

function rememberOrder(chainId, marketId, orderId, price, sellSymbol, sellQuantity, buySymbol, buyQuantity) {
    const timestamp = Date.now() / 1000;
    for (const [key, value] of Object.entries(PAST_ORDER_LIST)) {
        if (value['expiry'] < timestamp) {
            delete PAST_ORDER_LIST[key];
        }
    }

    const [baseSymbol, quoteSymbol] = marketId.split('-')
    let baseQuantity, quoteQuantity;
    if(sellSymbol === baseSymbol) {
        baseQuantity = sellQuantity;
        quoteQuantity = buyQuantity;
    } else {
        baseQuantity = buyQuantity;
        quoteQuantity = sellQuantity;
    }

    const expiry = timestamp + 900;
    PAST_ORDER_LIST[orderId] = {
        'chainId': chainId,
        'marketId': marketId,
        'price': price,
        'baseQuantity': baseQuantity,
        'quoteQuantity': quoteQuantity,
        'sellSymbol': sellSymbol,
        'sellQuantity': sellQuantity,
        'buySymbol': buySymbol,
        'buyQuantity': buyQuantity,
        'expiry':expiry
    };
}

async function updateAccountState() {
    try {
        Object.keys(WALLETS).forEach(accountId => {
            (WALLETS[accountId]['syncWallet']).getAccountState().then((state) => {
                WALLETS[accountId]['account_state'] = state;
            })
        });
    } catch(err) {
        // pass
    }
}

