# VaR and CVaR Reference

Use this skill when computing Value-at-Risk (VaR) or Expected Shortfall (CVaR/ES) — historical simulation, parametric, or Monte Carlo approaches — including backtesting and reporting patterns.

## Core Definitions

| Metric | Definition |
|--------|-----------|
| **VaR(α)** | Maximum loss not exceeded with probability α over horizon h. E.g. 99% 1-day VaR = loss exceeded only 1% of days. |
| **CVaR / ES(α)** | Expected loss *given* loss exceeds VaR(α). Always ≥ VaR; coherent risk measure. |
| **Stressed VaR** | VaR computed using a 250-day stressed observation window (e.g. GFC 2008). Required under Basel 2.5. |

---

## 1. Historical Simulation VaR

No distributional assumption; uses empirical P&L distribution.

```python
import numpy as np
import pandas as pd

def historical_var_cvar(
    returns: pd.Series,         # daily P&L or return series
    confidence: float = 0.99,   # e.g. 0.99 for 99% VaR
    portfolio_value: float = 1.0
) -> dict:
    """
    Historical simulation VaR and CVaR.
    Returns dollar (or notional) loss amounts (positive = loss).
    """
    alpha = 1 - confidence
    losses = -returns  # flip sign: loss is positive
    var  = np.quantile(losses, confidence)
    cvar = losses[losses >= var].mean()
    return {
        "VaR":  round(var  * portfolio_value, 6),
        "CVaR": round(cvar * portfolio_value, 6),
    }
```

### Multi-asset portfolio (with weighting)
```python
def portfolio_hist_var(
    asset_returns: pd.DataFrame,   # rows = dates, cols = assets
    weights: np.ndarray,            # portfolio weights summing to 1
    confidence: float = 0.99
) -> dict:
    port_returns = asset_returns @ weights
    return historical_var_cvar(port_returns, confidence)
```

---

## 2. Parametric (Variance-Covariance) VaR

Assumes returns are normally distributed. Fast; less accurate for fat-tailed assets.

```python
from scipy.stats import norm

def parametric_var_cvar(
    returns: pd.Series,
    confidence: float = 0.99,
    portfolio_value: float = 1.0
) -> dict:
    mu  = returns.mean()
    sig = returns.std()
    z   = norm.ppf(confidence)
    var  = -(mu - z * sig)
    cvar = -(mu - sig * norm.pdf(z) / (1 - confidence))
    return {
        "VaR":  round(var  * portfolio_value, 6),
        "CVaR": round(cvar * portfolio_value, 6),
    }

def parametric_portfolio_var(
    asset_returns: pd.DataFrame,
    weights: np.ndarray,
    confidence: float = 0.99
) -> dict:
    """Uses full covariance matrix for multi-asset portfolio."""
    cov   = asset_returns.cov().values
    mu    = asset_returns.mean().values
    p_mu  = weights @ mu
    p_sig = np.sqrt(weights @ cov @ weights)
    z     = norm.ppf(confidence)
    var   = -(p_mu - z * p_sig)
    cvar  = -(p_mu - p_sig * norm.pdf(z) / (1 - confidence))
    return {"VaR": round(var, 6), "CVaR": round(cvar, 6)}
```

---

## 3. Monte Carlo VaR

Best for non-linear portfolios (options) or custom correlation structures.

```python
def monte_carlo_var(
    mu: np.ndarray,             # mean return vector (n_assets,)
    cov: np.ndarray,            # covariance matrix (n_assets, n_assets)
    weights: np.ndarray,
    n_sims: int = 100_000,
    confidence: float = 0.99,
    horizon: int = 1,           # days
    seed: int = 42
) -> dict:
    rng = np.random.default_rng(seed)
    L   = np.linalg.cholesky(cov * horizon)
    z   = rng.standard_normal((n_sims, len(mu)))
    sim_returns = z @ L.T + mu * horizon   # shape: (n_sims, n_assets)
    port_returns = sim_returns @ weights
    losses = -port_returns
    var  = np.quantile(losses, confidence)
    cvar = losses[losses >= var].mean()
    return {"VaR": round(var, 6), "CVaR": round(cvar, 6)}
```

---

## 4. Scaling VaR to Different Horizons

**Square-root-of-time rule** (assumes i.i.d. returns — valid for short horizons):

```python
def scale_var(var_1day: float, horizon: int) -> float:
    """Scale 1-day VaR to h-day VaR using sqrt-of-time rule."""
    return var_1day * np.sqrt(horizon)
```

> **Warning:** SRT rule underestimates risk for fat-tailed or autocorrelated returns. For longer horizons, prefer Monte Carlo or filtered historical simulation.

---

## 5. Marginal, Component, and Incremental VaR

```python
def marginal_var(
    asset_returns: pd.DataFrame,
    weights: np.ndarray,
    confidence: float = 0.99,
    delta: float = 0.001
) -> np.ndarray:
    """
    Numerical estimate of marginal VaR: dVaR/dw_i.
    Shows which asset contributes most at the margin.
    """
    base = parametric_portfolio_var(asset_returns, weights, confidence)["VaR"]
    mvar = np.zeros(len(weights))
    for i in range(len(weights)):
        w2 = weights.copy()
        w2[i] += delta
        w2 /= w2.sum()  # renormalize
        up = parametric_portfolio_var(asset_returns, w2, confidence)["VaR"]
        mvar[i] = (up - base) / delta
    return mvar

def component_var(marginal: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """Component VaR: MVaR * w. Sums to total VaR."""
    return marginal * weights
```

---

## 6. VaR Backtesting

### Kupiec Proportion of Failures (POF) Test
```python
from scipy.stats import chi2

def kupiec_test(
    returns: pd.Series,
    var_series: pd.Series,   # VaR estimates aligned with returns
    confidence: float = 0.99
) -> dict:
    """
    H0: observed failure rate = 1 - confidence.
    Reject H0 (bad model) if p-value < 0.05.
    """
    alpha  = 1 - confidence
    T      = len(returns)
    losses = -returns
    n_fail = (losses > var_series).sum()
    p_hat  = n_fail / T
    if p_hat == 0 or p_hat == 1:
        return {"failures": n_fail, "failure_rate": p_hat, "p_value": np.nan}
    lr_pof = -2 * (
        n_fail * np.log(alpha / p_hat)
        + (T - n_fail) * np.log((1 - alpha) / (1 - p_hat))
    )
    p_val  = 1 - chi2.cdf(lr_pof, df=1)
    return {
        "failures":     int(n_fail),
        "failure_rate": round(p_hat, 4),
        "LR_POF":       round(lr_pof, 4),
        "p_value":      round(p_val, 4),
        "result":       "PASS" if p_val > 0.05 else "FAIL",
    }
```

### Basel traffic-light zones
| Failures (250 trading days) | Zone | Action |
|---|---|---|
| 0–4 | Green | No action |
| 5–9 | Yellow | Supervisory review |
| ≥ 10 | Red | Capital add-on / model review |

---

## 7. EWMA Covariance (RiskMetrics)

```python
def ewma_cov(
    returns: pd.DataFrame,
    lam: float = 0.94          # RiskMetrics decay factor for daily data
) -> pd.DataFrame:
    """Exponentially weighted covariance matrix (most recent data weighted highest)."""
    n = len(returns)
    weights = np.array([(1 - lam) * lam ** i for i in range(n - 1, -1, -1)])
    weights /= weights.sum()
    demeaned = returns.values - returns.mean().values
    cov = np.einsum("t,ti,tj->ij", weights, demeaned, demeaned)
    return pd.DataFrame(cov, index=returns.columns, columns=returns.columns)
```

---

## Common Gotchas

| Issue | Mitigation |
|-------|-----------|
| Fat tails underestimated by parametric VaR | Use historical simulation or Student-t parametric |
| SRT rule for multi-day horizons | Use MC or filtered historical simulation instead |
| VaR not additive across desks | Use CVaR (sub-additive, coherent) for aggregation |
| Short return history (< 250 days) | Stressed VaR or MC with calibrated vol |
| Window selection for HS-VaR | 250–500 days common; shorter = more reactive, longer = more stable |
