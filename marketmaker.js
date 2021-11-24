import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

let syncWallet, ethersProvider, syncProvider, ethWallet, noncesSinceLastCommitment, 
    lastPongReceived, pingServerInterval, fillOrdersInterval;
ethersProvider = ethers.getDefaultProvider(process.env.ETH_NETWORK);
try {
    syncProvider = await zksync.getDefaultProvider(process.env.ETH_NETWORK);
    ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY);
    syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);
    noncesSinceLastCommitment = 0;
    lastPongReceived = Date.now();
} catch (e) {
    throw new Error("Could not connect to zksync API");
}

const spotPrices = {};
const openOrders = {};

const CHAIN_ID = process.env.CHAIN_ID;
const MARKET_PAIRS = ["ETH-USDT", "ETH-USDC", "USDC-USDT"];
const CURRENCY_INFO = {
    "ETH": { 
        decimals: 18, 
        chain: { 
            1: { tokenId: 0 },
            1000: { tokenId: 0 },
        }
    },
    "USDC": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 2 },
            1000: { tokenId: 2 },
        }
    },
    "USDT": { 
        decimals: 6, 
        chain: { 
            1: { tokenId: 4 },
            1000: { tokenId: 1 },
        }
    },
}

let zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
zigzagws.on('open', onWsOpen);

function onWsOpen() {
    zigzagws.on('message', handleMessage);
    zigzagws.on('close', onWsClose);
    pingServerInterval = setInterval(pingServer, 5000);
    fillOrdersInterval = setInterval(fillOpenOrders, 10000);
    MARKET_PAIRS.forEach(market => {
        const msg = {op:"subscribemarket", args:[CHAIN_ID, market]};
        zigzagws.send(JSON.stringify(msg));
    });
}
    
function onWsClose () {
    console.log("Websocket closed. Restarting");
    setTimeout(() => {
        clearInterval(pingServerInterval)
        clearInterval(fillOrdersInterval)
        zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
        zigzagws.on('open', onWsOpen);
        zigzagws.on('error', onWsClose);
    }, 5000);
}

function pingServer() {
    const msg = {op:"ping"};
    zigzagws.send(JSON.stringify(msg));
    if (Date.now() - lastPongReceived > 20000) {
        console.log("Greater than 20s since last pong");
        zigzagws.close();
    }
}

async function handleMessage(json) {
    console.log(json.toString());
    const msg = JSON.parse(json);
    switch(msg.op) {
        case 'pong':
            lastPongReceived = Date.now();
            break
        case 'lastprice':
            const prices = msg.args[0];
            prices.forEach(row => {
                const market = row[0];
                const price = row[1];
                spotPrices[market] = price;
            });
            break
        case 'openorders':
            const orders = msg.args[0];
            orders.forEach(order => {
                const orderid = order[1];
                if (isOrderFillable(order)) {
                    sendfillrequest(order);
                }
                else {
                    openOrders[orderid] = order;
                }
            });
            break
        case "userordermatch":
            const chainid = msg.args[0];
            const orderid = msg.args[1];
            const result = await broadcastfill(chainid, orderid, msg.args[2], msg.args[3]);
            break
        case "cancelorderack":
            const canceled_ids = msg.args[0];
            canceled_ids.forEach(orderid => {
                delete openOrders[orderid]
            });
            break
        default:
            break
    }
}

function isOrderFillable(order) {
    const chainid = order[0];
    const market = order[2];
    const baseCurrency = market.split("-")[0];
    if (chainid != CHAIN_ID || !MARKET_PAIRS.includes(market)) {
        return false;
    }

    const spotPrice = spotPrices[market];
    if (!spotPrice) return false;
    let botAsk, botBid;
    if (baseCurrency === "ETH") {
        botAsk = spotPrice * 1.0005;
        botBid = spotPrice * 0.9995;
    } 
    else if (baseCurrency === "USDC") {
        botAsk = spotPrice * 1.0003;
        botBid = spotPrice * 0.9997;
    }


    const side = order[3];
    const price = order[4];
    if (side == 's' && price < botBid) {
        return true;
    }
    else if (side == 'b' && price > botAsk) {
        return true;
    }
    return false;
}

async function sendfillrequest(orderreceipt) {
  const chainId = orderreceipt[0];
  const orderId = orderreceipt[1];
  const market = orderreceipt[2];
  const baseCurrency = market.split("-")[0];
  const quoteCurrency = market.split("-")[1];
  const side = orderreceipt[3];
  let price = orderreceipt[4];
  const baseQuantity = orderreceipt[5];
  const quoteQuantity = orderreceipt[6];
  let tokenSell, tokenBuy, sellQuantity;
  if (side === "b") {
    price = price * 0.9997; // Add a margin of error to price
    tokenSell = baseCurrency;
    tokenBuy = quoteCurrency;
    if (tokenSell === "ETH") {
        sellQuantity = baseQuantity.toString();
    }
    else {
        sellQuantity = parseFloat(baseQuantity.toFixed(6)).toPrecision(8);
    }
  } else if (side === "s") {
    price = price * 1.0003; // Add a margin of error to price
    tokenSell = quoteCurrency;
    tokenBuy = baseCurrency;
    sellQuantity = parseFloat((quoteQuantity * 1.0001).toFixed(6)).toPrecision(8); // Add a margin of error to sellQuantity, max 6 decimal places, max 8 digits
  }
  const tokenRatio = {};
  tokenRatio[baseCurrency] = 1;
  tokenRatio[quoteCurrency] = parseFloat(price.toFixed(6));
  console.log(`${side} ${baseQuantity} ${baseCurrency} @ ${price}`);
  const orderDetails = {
    tokenSell,
    tokenBuy,
    amount: syncProvider.tokenSet.parseToken(
      tokenSell,
      sellQuantity
    ),
    ratio: zksync.utils.tokenRatio(tokenRatio),
  }
  if (noncesSinceLastCommitment > 0) {
      let nonce = await syncWallet.getNonce();
      nonce += noncesSinceLastCommitment;
      orderDetails.nonce = nonce;
  }
  const fillOrder = await syncWallet.getOrder(orderDetails);
  noncesSinceLastCommitment++;
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
  noncesSinceLastCommitment = 0;

  console.log("Swap broadcast result", {swap, receipt});
  const newstatus = success ? 'f' : 'r';
  const error = success ? null : swap.error.toString();
  const ordercommitmsg = {op:"orderstatusupdate", args:[[[chainid,orderid,newstatus,txhash,error]]]}
  zigzagws.send(JSON.stringify(ordercommitmsg));
}

async function fillOpenOrders() {
    for (let orderid in openOrders) {
        const order = openOrders[orderid];
        if (isOrderFillable(order)) {
            sendfillrequest(order);
            delete openOrders[orderid];
        }
    }
}
