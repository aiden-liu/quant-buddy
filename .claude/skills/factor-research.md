# Factor Research Reference

Use this skill when building, evaluating, or comparing quantitative equity factors — signal construction, IC/ICIR analysis, forward-return quantile analysis, and factor decay.

## Factor Construction Patterns

### Cross-sectional z-score normalization
```python
import pandas as pd
import numpy as np

def cross_section_zscore(raw: pd.DataFrame) -> pd.DataFrame:
    """Normalize each factor cross-sectionally per date (rows = dates, cols = assets)."""
    return raw.sub(raw.mean(axis=1), axis=0).div(raw.std(axis=1), axis=0)

def winsorize(raw: pd.DataFrame, pct: float = 0.01) -> pd.DataFrame:
    """Clip extreme values at `pct` and `1-pct` quantile per date."""
    lo = raw.quantile(pct, axis=1)
    hi = raw.quantile(1 - pct, axis=1)
    return raw.clip(lower=lo, upper=hi, axis=0)
```

### Momentum factor (12-1 month price momentum)
```python
def momentum_12_1(prices: pd.DataFrame) -> pd.DataFrame:
    """
    Standard Jegadeesh-Titman momentum: cumulative return from t-252 to t-21.
    prices: DataFrame with dates as index, tickers as columns (adjusted close).
    """
    ret_12 = prices.shift(21) / prices.shift(252) - 1
    return cross_section_zscore(winsorize(ret_12))
```

### Value factor (book-to-market)
```python
def book_to_market(book_value: pd.DataFrame, market_cap: pd.DataFrame) -> pd.DataFrame:
    """B/M ratio, higher = cheaper (value tilt)."""
    bm = book_value / market_cap
    return cross_section_zscore(winsorize(bm))
```

### Quality factor (ROE)
```python
def roe_quality(net_income: pd.DataFrame, equity: pd.DataFrame) -> pd.DataFrame:
    """Return on equity as a quality signal."""
    roe = net_income / equity
    return cross_section_zscore(winsorize(roe))
```

---

## Information Coefficient (IC) Analysis

IC measures the rank correlation between a factor and forward returns. Higher absolute IC = more predictive signal.

### Computing IC (Spearman rank correlation per date)
```python
from scipy.stats import spearmanr

def compute_ic(factor: pd.DataFrame, fwd_returns: pd.DataFrame) -> pd.Series:
    """
    Compute cross-sectional Spearman IC for each date.
    Both DataFrames: rows = dates, cols = assets.
    """
    ics = {}
    for date in factor.index:
        f = factor.loc[date].dropna()
        r = fwd_returns.loc[date].dropna()
        common = f.index.intersection(r.index)
        if len(common) < 10:
            continue
        ic, _ = spearmanr(f[common], r[common])
        ics[date] = ic
    return pd.Series(ics, name="IC")

def ic_summary(ic: pd.Series) -> dict:
    return {
        "Mean IC":   round(ic.mean(), 4),
        "IC Std":    round(ic.std(), 4),
        "ICIR":      round(ic.mean() / ic.std(), 4),  # annualised: * sqrt(252/holding_period)
        "IC > 0 (%)": round((ic > 0).mean() * 100, 1),
    }
```

**Rule of thumb:**
| ICIR | Signal quality |
|------|---------------|
| < 0.3 | Weak |
| 0.3 – 0.5 | Moderate |
| 0.5 – 1.0 | Strong |
| > 1.0 | Exceptional (check for look-ahead bias) |

---

## Forward Returns Construction

```python
def compute_forward_returns(
    prices: pd.DataFrame,
    holding_periods: list[int] = [5, 10, 21]
) -> dict[int, pd.DataFrame]:
    """
    Compute forward log returns for each holding period.
    Shifts are negative (look forward). Align with factor dates before IC calc.
    """
    fwd = {}
    for h in holding_periods:
        fwd[h] = np.log(prices.shift(-h) / prices)
    return fwd
```

> **Look-ahead discipline:** always align factor values at date `t` with returns from `t` to `t+h`. Never use prices or fundamentals past `t`.

---

## Quantile Analysis (Alphalens-style)

```python
def quantile_returns(
    factor: pd.DataFrame,
    fwd_returns: pd.DataFrame,
    n_quantiles: int = 5
) -> pd.DataFrame:
    """
    For each date, bucket assets into n_quantiles by factor rank.
    Returns mean forward return per quantile per date.
    """
    records = []
    for date in factor.index:
        f = factor.loc[date].dropna()
        r = fwd_returns.loc[date].dropna()
        common = f.index.intersection(r.index)
        if len(common) < n_quantiles * 3:
            continue
        labels = pd.qcut(f[common], n_quantiles, labels=False, duplicates="drop")
        for q in range(n_quantiles):
            assets = labels[labels == q].index
            records.append({"date": date, "quantile": q + 1,
                            "mean_fwd_ret": r[assets].mean()})
    df = pd.DataFrame(records).set_index("date")
    return df.groupby(["date", "quantile"])["mean_fwd_ret"].mean().unstack("quantile")

def long_short_spread(quantile_df: pd.DataFrame) -> pd.Series:
    """Long top quantile, short bottom quantile."""
    top = quantile_df.iloc[:, -1]
    bot = quantile_df.iloc[:, 0]
    return (top - bot).rename("LS_spread")
```

---

## Factor Decay Analysis

```python
def factor_decay(
    factor: pd.DataFrame,
    prices: pd.DataFrame,
    max_lag: int = 63
) -> pd.Series:
    """IC at each lag from 1 to max_lag to measure how fast signal decays."""
    fwd_all = compute_forward_returns(prices, list(range(1, max_lag + 1)))
    decay = {lag: compute_ic(factor, fwd_all[lag]).mean() for lag in range(1, max_lag + 1)}
    return pd.Series(decay, name="IC_decay")
```

Plot with `decay.plot(title="Factor IC decay")`. A rapidly decaying IC suggests a short holding period is optimal.

---

## Factor Orthogonalization

Remove linear exposure to a benchmark factor before evaluating a new signal:

```python
import statsmodels.api as sm

def orthogonalize(target: pd.Series, benchmark: pd.Series) -> pd.Series:
    """
    Regress `target` on `benchmark` (cross-sectionally) and return residuals.
    Use when you want the pure alpha of `target` unexplained by `benchmark`.
    """
    common = target.dropna().index.intersection(benchmark.dropna().index)
    X = sm.add_constant(benchmark[common])
    model = sm.OLS(target[common], X).fit()
    return model.resid
```

---

## Common Pitfalls

| Pitfall | Mitigation |
|---------|-----------|
| Survivorship bias | Use point-in-time universe (include delisted stocks) |
| Look-ahead in fundamentals | Use as-reported dates, not fiscal period end dates |
| Overfitting from multiple testing | Apply BHY correction; use out-of-sample holdout |
| Fat-tailed factor values | Winsorize before z-scoring |
| Short IC history | Require ≥ 3 years for stable ICIR estimate |
