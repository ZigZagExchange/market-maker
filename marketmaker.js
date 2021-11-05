import WebSocket from 'ws';
import * as zksync from "zksync";
import ethers from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const ethersProvider = ethers.getDefaultProvider(process.env.ETH_NETWORK);
const syncProvider = await zksync.getDefaultProvider(process.env.ETH_NETWORK);
const ethWallet = new ethers.Wallet(process.env.ETH_PRIVKEY);
const syncWallet = await zksync.Wallet.fromEthSigner(ethWallet, syncProvider);

const spotPrices = {};
const openOrders = {};

const zigzagws = new WebSocket(process.env.ZIGZAG_WS_URL);
zigzagws.on('open', function open() {
    setInterval(pingServer, 5000);
    setInterval(fillOpenOrders, 10000);
    const msg = {op:"subscribemarket", args:[1,"ETH-USDT"]};
    zigzagws.send(JSON.stringify(msg));
});
zigzagws.on('message', handleMessage);

function pingServer() {
    const msg = {op:"ping"};
    zigzagws.send(JSON.stringify(msg));
}

async function handleMessage(json) {
    console.log(json.toString());
    const msg = JSON.parse(json);
    switch(msg.op) {
        case 'pong':
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
            const result = await broadcastfill(msg.args[1], msg.args[2]);
            console.log("Swap broadcast result", result);
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
    if (chainid != 1 || market != "ETH-USDT") {
        return false;
    }

    const spotPrice = spotPrices[market];
    if (!spotPrice) return false;
    const botAsk = spotPrice * 1.0013;
    const botBid = spotPrice * 0.9987;

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
  const orderId = orderreceipt[1];
  const market = orderreceipt[2];
  const baseCurrency = market.split("-")[0];
  const quoteCurrency = market.split("-")[1];
  const side = orderreceipt[3];
  let price = orderreceipt[4];
  const baseQuantity = orderreceipt[5].toString();
  const quoteQuantity = orderreceipt[6].toString();
  let tokenSell, tokenBuy, sellQuantity;
  if (side === "b") {
    price = price * 0.9999; // Add a margin of error to price
    tokenSell = baseCurrency;
    tokenBuy = quoteCurrency;
    sellQuantity = baseQuantity;
  } else if (side === "s") {
    price = price * 1.0001; // Add a margin of error to price
    tokenSell = quoteCurrency;
    tokenBuy = baseCurrency;
    sellQuantity = quoteQuantity;
  }
  const tokenRatio = {};
  tokenRatio[baseCurrency] = 1;
  tokenRatio[quoteCurrency] = parseFloat(price.toPrecision(6));
  const fillOrder = await syncWallet.getOrder({
    tokenSell,
    tokenBuy,
    amount: syncProvider.tokenSet.parseToken(
      tokenSell,
      sellQuantity
    ),
    ratio: zksync.utils.tokenRatio(tokenRatio),
  });
  const resp = { op: "fillrequest", args: [orderId, fillOrder] };
  zigzagws.send(JSON.stringify(resp));
}

async function broadcastfill(swapOffer, fillOrder) {
  const swap = await syncWallet.syncSwap({
    orders: [swapOffer, fillOrder],
    feeToken: "ETH",
  });
  let receipt;
  try {
    receipt = await swap.awaitReceipt();
  } catch (e) {
    return { success: false, swap, receipt: null };
  }
  return { success: true, swap, receipt };
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
