import yfinance as yf
import pandas as pd
import json
from datetime import datetime

def download_data(symbol, period, interval):
    print(f"Downloading {interval} data for {symbol}...")
    df = yf.download(symbol, period=period, interval=interval)
    if df.empty:
        print(f"No data found for {interval}")
        return []
    
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    
    candles = []
    for index, row in df.iterrows():
        candles.append({
            "time": int(index.timestamp() * 1000),
            "open": float(row['Open']),
            "high": float(row['High']),
            "low": float(row['Low']),
            "close": float(row['Close']),
            "volume": float(row['Volume'])
        })
    return candles

symbol = "GC=F" 
data_1m = download_data(symbol, "7d", "1m")
data_5m = download_data(symbol, "7d", "5m")
data_15m = download_data(symbol, "7d", "15m")
data_1h = download_data(symbol, "30d", "1h")
data_1d = download_data(symbol, "60d", "1d")

all_data = {
    "1m": data_1m,
    "5m": data_5m,
    "15m": data_15m,
    "1h": data_1h,
    "1d": data_1d
}

with open("/home/ubuntu/Ricky/historical_data.json", "w") as f:
    json.dump(all_data, f)

print("Data saved to historical_data.json")
print(f"1m candles: {len(data_1m)}")
print(f"5m candles: {len(data_5m)}")
print(f"15m candles: {len(data_15m)}")
print(f"1h candles: {len(data_1h)}")
print(f"1d candles: {len(data_1d)}")
