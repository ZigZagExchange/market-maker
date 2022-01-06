import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';

dotenv.config();

// Load MM config
let MM_CONFIG;
if (process.env.MM_CONFIG) {
    MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
}
else {
    const mmConfigFile = fs.readFileSync("config.json", "utf8");
    MM_CONFIG = JSON.parse(mmConfigFile);
}
console.log(MM_CONFIG);
const activePairs = Object.keys(MM_CONFIG.pairs).join(',');

// Initiate fill loop
let ORDER_BROADCASTING = false;
const FILL_QUEUE = [];
setTimeout(processFillQueue, 1000);

// Connect to zksync
const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
const ETH_NETWORK = (CHAIN_ID === 1) ? "mainnet" : "rinkeby";
let syncWallet, ethersProvider, syncProvider, ethWallet, 
    fillOrdersInterval, accountState;
ethersProvider = ethers.getDefaultProvider(ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultProvider(ETH_NETWORK);
    ethWallet = new ethers.Wallet(MM_CONFIG.ethPrivKey);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    if (!(await syncWallet.isSigningKeySet())) {
        console.log("setting sign key");
        const signKeyResult = await syncWallet.setSigningKey({
            feeToken: "ETH",
            ethAuthType: "ECDSA",
        });
        console.log(signKeyResult);
    }
    accountState = await syncWallet.getAccountState();
} catch (e) {
    console.log(e);
    throw new Error("Could not connect to zksync API");
}

const SPOT_PRICES = {};
const OPEN_ORDERS = {};

// Get markets info
const markets_url = `https://zigzag-markets.herokuapp.com/markets?chainid=${CHAIN_ID}&id=${activePairs}`
const markets = await fetch(markets_url).then(r => r.json());
console.log(markets);
const MARKETS = {};
for (let i in markets) {
    const market = markets[i];
    MARKETS[market.id] = market;
    if (market.alias) {
        MARKETS[market.alias] = market;
    }
}

let zigzagws = new WebSocket(MM_CONFIG.zigzagWsUrl);
zigzagws.on('open', onWsOpen);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    zigzagws.on('close', onWsClose);
    fillOrdersInterval = setInterval(fillOpenOrders, 5000);
    for (let market in MM_CONFIG.pairs) {
        const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
        zigzagws.send(JSON.stringify(msg));
    }
}
    
function onWsClose () {
    console.log("Websocket closed. Restarting");
    ORDER_BROADCASTING = false;
    setTimeout(() => {
        clearInterval(fillOrdersInterval)
        zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('error', onWsClose);
    }, 5000);
}

async function handleMessage(json) {
    const msg = JSON.parse(json);
    if (msg.op != "lastprice") console.log(json.toString());
    switch(msg.op) {
        case 'error':
            ORDER_BROADCASTING = false;
            break;
        case 'lastprice':
            const prices = msg.args[0];
            prices.forEach(row => {
                const market = row[0];
                const price = row[1];
                SPOT_PRICES[market] = price;
            });
            break
        case 'orders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderid = order[1];
                const fillable = isOrderFillable(order);
                console.log(fillable);
                if (fillable.fillable) {
                    FILL_QUEUE.push(order);
                }
                else if (fillable.reason === "badprice") {
                    OPEN_ORDERS[orderid] = order;
                }
            });
            break
        case "userordermatch":
            const chainid = msg.args[0];
            const orderid = msg.args[1];
            try {
                await broadcastfill(chainid, orderid, msg.args[2], msg.args[3]);
            } catch (e) {
                console.error(e);
            }
            ORDER_BROADCASTING = false;
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainid = order[0];
    const market_id = order[2];
    const market = MARKETS[market_id];
    const mmConfig = MM_CONFIG.pairs[market_id];
    if (chainid != CHAIN_ID) return { fillable: false, reason: "badchain" }
    if (!market) return { fillable: false, reason: "badmarket" }

    const baseQuantity = order[5];
    const quoteQuantity = order[6];
    const expires = order[7];
    const side = order[3];
    const price = order[4];
    const now = Date.now() / 1000 | 0;
    if (now > expires) {
        return { fillable: false, reason: "expired" };
    }
    
    if (baseQuantity < mmConfig.minSize) {
        return { fillable: false, reason: "badsize" };
    }
    else if (baseQuantity > mmConfig.maxSize) {
        return { fillable: false, reason: "badsize" };
    }

    let quote;
    try {
        quote = genquote(chainid, market_id, side, baseQuantity);
    } catch (e) {
        return { fillable: false, reason: e.message }
    }

    if (side == 's' && price > quote.hardPrice) {
        return { fillable: false, reason: "badprice" };
    }
    else if (side == 'b' && price < quote.hardPrice) {
        return { fillable: false, reason: "badprice" };
    }

    return { fillable: true, reason: null };
}

function genquote(chainid, market_id, side, baseQuantity) {
    const market = MARKETS[market_id];
    if (CHAIN_ID !== chainid) throw new Error("badchain");
    if (!market) throw new Error("badmarket");
    if (!(['b','s']).includes(side)) throw new Error("badside");
    if (baseQuantity <= 0) throw new Error("badquantity");

    const mmConfig = MM_CONFIG.pairs[market_id];
    const lastPrice = SPOT_PRICES[market_id];
    const SPREAD = mmConfig.minSpread + (baseQuantity * mmConfig.slippageRate);
    let quoteQuantity;
    if (side === 'b') {
        quoteQuantity = (baseQuantity * lastPrice * (1 + SPREAD)) + market.quoteFee;
    }
    else if (side === 's') {
        quoteQuantity = (baseQuantity - market.baseFee) * lastPrice * (1 - SPREAD);
    }
    const quotePrice = (quoteQuantity / baseQuantity).toPrecision(6);
    if (quotePrice < 0) throw new Error("Amount is inadequate to pay fee");
    if (isNaN(quotePrice)) throw new Error("Internal Error. No price generated.");
    return { quotePrice, quoteQuantity };
}

async function sendfillrequest(orderreceipt) {
  const chainId = orderreceipt[0];
  const orderId = orderreceipt[1];
  const market_id = orderreceipt[2];
  const market = MARKETS[market_id];
  const baseCurrency = market.baseAssetId;
  const quoteCurrency = market.quoteAssetId;
  const side = orderreceipt[3];
  let price = orderreceipt[4];
  const baseQuantity = orderreceipt[5];
  const quoteQuantity = orderreceipt[6];
  let tokenSell, tokenBuy, sellQuantity;
  if (side === "b") {
    tokenSell = market.baseAssetId;
    tokenBuy = market.quoteAssetId;
    sellQuantity = baseQuantity.toFixed(market.baseAsset.decimals);
  } else if (side === "s") {
    tokenSell = market.quoteAssetId;
    tokenBuy = market.baseAssetId;
    sellQuantity = quoteQuantity.toFixed(market.quoteAsset.decimals);
  }
  sellQuantity = syncProvider.tokenSet.parseToken(
    tokenSell,
    sellQuantity
  );
  sellQuantity = zksync.utils.closestPackableTransactionAmount(sellQuantity);
  const tokenRatio = {};
  tokenRatio[baseCurrency] = baseQuantity.toFixed(market.baseAsset.decimals);
  tokenRatio[quoteCurrency] = quoteQuantity.toFixed(market.quoteAsset.decimals);
  console.log(tokenRatio);
  console.log(sellQuantity.toString());
  const one_min_expiry = (Date.now() / 1000 | 0) + 60;
  const orderDetails = {
    tokenSell,
    tokenBuy,
    amount: sellQuantity,
    ratio: zksync.utils.tokenRatio(tokenRatio),
    validUntil: one_min_expiry
  }
  const fillOrder = await syncWallet.getOrder(orderDetails);
    
  // Set global flag 
  ORDER_BROADCASTING = true;

  const resp = { op: "fillrequest", args: [chainId, orderId, fillOrder] };
  zigzagws.send(JSON.stringify(resp));
}

async function broadcastfill(chainid, orderid, swapOffer, fillOrder) {
  const randint = (Math.random()*1000).toFixed(0);
  console.time('syncswap' + randint);
  const swap = await syncWallet.syncSwap({
    orders: [swapOffer, fillOrder],
    feeToken: "ETH",
    nonce: fillOrder.nonce
  });
  const txhash = swap.txHash.split(":")[1];
  const txhashmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,'b',txhash]]]}
  zigzagws.send(JSON.stringify(txhashmsg));
  console.timeEnd('syncswap' + randint);

  console.time('receipt' + randint);
  let receipt, success;
  try {
    receipt = await swap.awaitReceipt();
    if (receipt.success) success = true;
  } catch (e) {
    receipt = null;
    success = false;
  }
  console.timeEnd('receipt' + randint);

  console.log("Swap broadcast result", {swap, receipt});
  const newstatus = success ? 'f' : 'r';
  const error = success ? null : swap.error.toString();
  const ordercommitmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,newstatus,txhash,error]]]}
  zigzagws.send(JSON.stringify(ordercommitmsg));
}

async function fillOpenOrders() {
    for (let orderid in OPEN_ORDERS) {
        const order = OPEN_ORDERS[orderid];
        const fillable = isOrderFillable(order);
        if (fillable.fillable) {
            FILL_QUEUE.push(order);
            delete OPEN_ORDERS[orderid];
        }
        else if (fillable.reason !== "badprice") {
            delete OPEN_ORDERS[orderid];
        }
    }
}

async function processFillQueue() {
    if (ORDER_BROADCASTING) {
        setTimeout(processFillQueue, 100);
        return false;
    }
    if (FILL_QUEUE.length === 0) {
        setTimeout(processFillQueue, 100);
        return false;
    }
    const order = FILL_QUEUE.shift();
    try {
        await sendfillrequest(order);
    } catch (e) {
        console.error(e);
        ORDER_BROADCASTING = false;
    }
    setTimeout(processFillQueue, 50);
}
