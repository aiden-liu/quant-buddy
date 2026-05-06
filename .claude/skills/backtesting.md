# Backtesting Reference

Use this skill when implementing or reviewing a quantitative strategy backtest — vectorized simulation, transaction cost modelling, performance metrics, and avoiding common biases.

## Vectorized Backtest Skeleton

```python
import numpy as np
import pandas as pd

def vectorized_backtest(
    signals: pd.DataFrame,        # rows = dates, cols = assets; values in [-1, 1]
    prices: pd.DataFrame,         # adjusted close, same shape
    cost_bps: float = 5.0,        # one-way transaction cost in basis points
    signal_lag: int = 1,          # execution lag (1 = trade next open after signal)
) -> pd.Series:
    """
    Simple vectorized backtest. Returns a daily strategy P&L series.
    Signals are target weights; rebalances whenever weight changes.
    """
    # Lag signals to avoid look-ahead bias
    positions = signals.shift(signal_lag).fillna(0)

    # Daily log returns
    log_ret = np.log(prices / prices.shift(1))

    # Gross P&L
    gross_pnl = (positions.shift(1) * log_ret).sum(axis=1)

    # Transaction costs: cost on turnover
    turnover = positions.diff().abs().sum(axis=1)
    costs = turnover * cost_bps / 10_000

    net_pnl = gross_pnl - costs
    return net_pnl.rename("strategy_pnl")
```

---

## Performance Metrics

```python
def performance_metrics(
    pnl: pd.Series,
    periods_per_year: int = 252
) -> dict:
    """Compute standard performance metrics from a daily P&L series."""
    cum = pnl.cumsum()
    rolling_max = cum.cummax()
    drawdown = cum - rolling_max

    ann_ret  = pnl.mean() * periods_per_year
    ann_vol  = pnl.std() * np.sqrt(periods_per_year)
    sharpe   = ann_ret / ann_vol if ann_vol > 0 else np.nan
    sortino  = ann_ret / (pnl[pnl < 0].std() * np.sqrt(periods_per_year))
    max_dd   = drawdown.min()
    calmar   = ann_ret / abs(max_dd) if max_dd != 0 else np.nan
    hit_rate = (pnl > 0).mean()

    return {
        "Ann. Return":   round(ann_ret * 100, 2),
        "Ann. Vol":      round(ann_vol * 100, 2),
        "Sharpe":        round(sharpe, 3),
        "Sortino":       round(sortino, 3),
        "Max Drawdown":  round(max_dd * 100, 2),
        "Calmar":        round(calmar, 3),
        "Hit Rate (%)":  round(hit_rate * 100, 1),
    }
```

### Deflated Sharpe Ratio (Bailey & López de Prado 2014)

Adjusts for multiple hypothesis testing when a strategy was selected from many trials:

```python
from scipy.stats import norm

def deflated_sharpe(
    sharpe_obs: float,
    n_trials: int,
    n_obs: int,
    skew: float = 0.0,
    kurt: float = 3.0
) -> float:
    """
    Compute the Deflated Sharpe Ratio.
    sharpe_obs: observed annualized Sharpe (from backtest)
    n_trials:   number of strategy configurations tested
    n_obs:      number of daily observations in backtest
    """
    # Expected maximum Sharpe under iid Gaussian returns after n_trials
    euler_gamma = 0.5772156649015329  # Euler-Mascheroni constant
    e_max = (
        (1 - euler_gamma) * norm.ppf(1 - 1 / n_trials)
        + euler_gamma * norm.ppf(1 - 1 / (n_trials * np.e))
    )
    sharpe_std = np.sqrt(
        (1 - skew * sharpe_obs + (kurt - 1) / 4 * sharpe_obs**2) / (n_obs - 1)
    )
    dsr = norm.cdf((sharpe_obs - e_max) / sharpe_std)
    return round(dsr, 4)
```

---

## Purged K-Fold Cross-Validation

Standard k-fold leaks information across folds due to overlapping return horizons. Use purged CV to prevent this:

```python
def purged_kfold_splits(
    n: int,
    n_splits: int = 5,
    embargo_frac: float = 0.01
) -> list[tuple[np.ndarray, np.ndarray]]:
    """
    Generate purged train/test index splits.
    embargo_frac: fraction of n to embargo after each test fold.
    """
    indices = np.arange(n)
    fold_size = n // n_splits
    embargo = int(n * embargo_frac)
    splits = []
    for k in range(n_splits):
        test_start = k * fold_size
        test_end   = (k + 1) * fold_size if k < n_splits - 1 else n
        test_idx   = indices[test_start:test_end]
        train_idx  = np.concatenate([
            indices[:max(0, test_start - embargo)],
            indices[min(n, test_end + embargo):]
        ])
        splits.append((train_idx, test_idx))
    return splits
```

---

## Transaction Cost Modelling

| Component | Typical magnitude | Model |
|-----------|-------------------|-------|
| Bid-ask spread | 1–5 bps (liquid large cap) | Half-spread on each side |
| Commission | 0.5–2 bps | Fixed per-trade |
| Market impact (small) | ~ `σ * sqrt(ADV_frac)` | Square-root impact model |
| Slippage (intraday) | 1–3 bps | Empirical estimate |

### Square-root market impact
```python
def market_impact_bps(
    trade_notional: float,
    adv_notional: float,   # average daily volume in notional
    daily_vol: float,      # daily return volatility of the asset
    eta: float = 0.1       # market impact coefficient (Almgren et al.)
) -> float:
    """Estimate one-way market impact in bps using the square-root model."""
    adv_frac = trade_notional / adv_notional
    impact = eta * daily_vol * np.sqrt(adv_frac)
    return impact * 10_000  # convert to bps
```

---

## Walk-Forward Validation

```python
def walk_forward_periods(
    start: pd.Timestamp,
    end: pd.Timestamp,
    train_months: int = 36,
    test_months: int = 6
) -> list[dict]:
    """Generate rolling train/test windows for walk-forward validation."""
    periods = []
    t = start + pd.DateOffset(months=train_months)
    while t + pd.DateOffset(months=test_months) <= end:
        periods.append({
            "train_start": t - pd.DateOffset(months=train_months),
            "train_end":   t - pd.DateOffset(days=1),
            "test_start":  t,
            "test_end":    t + pd.DateOffset(months=test_months) - pd.DateOffset(days=1),
        })
        t += pd.DateOffset(months=test_months)
    return periods
```

---

## Common Biases and Fixes

| Bias | Symptom | Fix |
|------|---------|-----|
| Look-ahead | In-sample Sharpe collapses out-of-sample | Enforce signal lag ≥ 1 day; use `shift()` |
| Survivorship | Overstated returns vs live performance | Include delisted securities |
| Overfitting | DSR < 0.95 despite high Sharpe | Reduce parameters; use purged CV |
| Transaction cost underestimation | Paper vs live gap | Model spread + impact; assume 5–10 bps for liquid mid-cap |
| Regime overfitting | Strategy works only in one market regime | Test across multiple sub-periods |
