# Options Pricing and Greeks Reference

Use this skill when pricing options, computing Greeks (sensitivities), constructing hedges, or explaining options P&L decomposition using the Black-Scholes-Merton framework.

## Black-Scholes-Merton Price

```python
import numpy as np
from scipy.stats import norm

def bsm_price(
    S: float,       # current spot price
    K: float,       # strike price
    T: float,       # time to expiry in years
    r: float,       # risk-free rate (continuously compounded)
    sigma: float,   # implied/historical volatility (annualized)
    q: float = 0.0, # continuous dividend yield
    option_type: str = "call"  # "call" or "put"
) -> float:
    """Black-Scholes-Merton option price."""
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    if option_type == "call":
        price = S * np.exp(-q * T) * norm.cdf(d1) - K * np.exp(-r * T) * norm.cdf(d2)
    else:
        price = K * np.exp(-r * T) * norm.cdf(-d2) - S * np.exp(-q * T) * norm.cdf(-d1)
    return price
```

---

## Greeks

### First-order Greeks

```python
def greeks(
    S: float, K: float, T: float,
    r: float, sigma: float, q: float = 0.0,
    option_type: str = "call"
) -> dict:
    """Compute all standard BSM Greeks."""
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    nd1  = norm.cdf(d1)
    nd1_ = norm.cdf(-d1)
    phi  = norm.pdf(d1)   # standard normal PDF at d1

    sign = 1 if option_type == "call" else -1

    delta = np.exp(-q * T) * norm.cdf(sign * d1) * sign

    gamma = np.exp(-q * T) * phi / (S * sigma * np.sqrt(T))

    vega  = S * np.exp(-q * T) * phi * np.sqrt(T) / 100  # per 1 vol point

    theta_call = (
        - S * np.exp(-q * T) * phi * sigma / (2 * np.sqrt(T))
        - r * K * np.exp(-r * T) * norm.cdf(d2)
        + q * S * np.exp(-q * T) * norm.cdf(d1)
    ) / 365  # per calendar day

    theta_put = (
        - S * np.exp(-q * T) * phi * sigma / (2 * np.sqrt(T))
        + r * K * np.exp(-r * T) * norm.cdf(-d2)
        - q * S * np.exp(-q * T) * norm.cdf(-d1)
    ) / 365

    theta = theta_call if option_type == "call" else theta_put

    rho_call = K * T * np.exp(-r * T) * norm.cdf(d2)  / 100  # per 1 bp
    rho_put  = -K * T * np.exp(-r * T) * norm.cdf(-d2) / 100
    rho = rho_call if option_type == "call" else rho_put

    return {
        "delta": round(delta, 6),
        "gamma": round(gamma, 6),
        "vega":  round(vega,  6),   # per 1% move in vol
        "theta": round(theta, 6),   # per calendar day
        "rho":   round(rho,   6),   # per 1% move in rate
    }
```

### Second-order Greeks

```python
def second_order_greeks(
    S: float, K: float, T: float,
    r: float, sigma: float, q: float = 0.0
) -> dict:
    """Vanna and Volga (same for calls and puts under BSM)."""
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
    d2 = d1 - sigma * np.sqrt(T)
    phi = norm.pdf(d1)

    # Vanna: dDelta/dSigma = dVega/dS
    vanna = -np.exp(-q * T) * phi * d2 / sigma

    # Volga (Vomma): dVega/dSigma
    vega_raw = S * np.exp(-q * T) * phi * np.sqrt(T)
    volga = vega_raw * d1 * d2 / sigma

    return {
        "vanna": round(vanna, 6),
        "volga": round(volga, 6),
    }
```

---

## Greeks Interpretation Table

| Greek | Measures | Unit | Rule of thumb |
|-------|---------|------|--------------|
| **Delta** (Δ) | Price sensitivity to spot | $ per $1 move | Call ∈ (0,1), Put ∈ (-1,0) |
| **Gamma** (Γ) | Rate of change of delta | $ per $1² move | High near ATM, near expiry |
| **Vega** (ν) | Sensitivity to vol | $ per 1 vol pt | Long options → long vega |
| **Theta** (Θ) | Time decay | $ per day | Long options → negative theta |
| **Rho** (ρ) | Interest rate sensitivity | $ per 1 bp | Long calls → positive rho |
| **Vanna** | Δ/σ or ν/S | Mixed | FX smile risk |
| **Volga** | ν/σ | $ per vol² | Smile curvature |

---

## Delta Hedging P&L Simulation

```python
def delta_hedge_pnl(
    S_path: np.ndarray,   # simulated spot path, shape (T+1,)
    K: float, r: float, sigma: float, q: float = 0.0,
    option_type: str = "call",
    dt: float = 1/252,    # rebalance interval in years
) -> dict:
    """
    Simulate discrete delta-hedging P&L of a short option position.
    Net P&L should be close to 0 if vol realised ≈ implied (BSM world).
    """
    T_total = len(S_path) - 1
    hedge_pnl  = 0.0
    delta_prev = 0.0

    for t in range(T_total):
        tau = (T_total - t) * dt
        if tau <= 0:
            break
        g = greeks(S_path[t], K, tau, r, sigma, q, option_type)
        delta_now = g["delta"]

        if t > 0:
            # P&L from holding delta_prev shares over dt
            hedge_pnl += delta_prev * (S_path[t] - S_path[t - 1])
        delta_prev = delta_now

    option_pnl = bsm_price(S_path[0], K, T_total * dt, r, sigma, q, option_type) \
                 - max(0, (S_path[-1] - K) if option_type == "call" else (K - S_path[-1]))

    return {
        "hedge_pnl":  round(hedge_pnl, 6),
        "option_pnl": round(option_pnl, 6),
        "net_pnl":    round(option_pnl + hedge_pnl, 6),
    }
```

---

## Implied Volatility (Newton-Raphson)

```python
def implied_vol(
    market_price: float,
    S: float, K: float, T: float, r: float,
    q: float = 0.0,
    option_type: str = "call",
    tol: float = 1e-6,
    max_iter: int = 100
) -> float:
    """Solve for implied volatility using Newton-Raphson."""
    sigma = 0.3  # initial guess
    for _ in range(max_iter):
        price  = bsm_price(S, K, T, r, sigma, q, option_type)
        d1     = (np.log(S / K) + (r - q + 0.5 * sigma**2) * T) / (sigma * np.sqrt(T))
        vega_v = S * np.exp(-q * T) * norm.pdf(d1) * np.sqrt(T)
        diff   = price - market_price
        if abs(diff) < tol:
            return round(sigma, 6)
        if vega_v < 1e-10:
            break
        sigma -= diff / vega_v
        sigma = max(1e-6, sigma)   # keep positive
    return round(sigma, 6)
```

---

## P&L Attribution (Taylor Expansion)

The daily P&L of an option position can be decomposed as:

```
ΔP ≈ Δ · ΔS  +  ½Γ · ΔS²  +  ν · Δσ  +  Θ · Δt
        delta      gamma           vega      theta
```

```python
def pnl_attribution(
    greeks_dict: dict,
    dS: float,       # spot move
    dvol: float,     # vol move (in decimal, e.g. 0.01 = +1 vol pt)
    dt:  float = 1/252
) -> dict:
    g = greeks_dict
    delta_pnl = g["delta"] * dS
    gamma_pnl = 0.5 * g["gamma"] * dS**2
    vega_pnl  = g["vega"]  * dvol * 100   # vega is per 1 vol pt
    theta_pnl = g["theta"] * dt * 365      # theta is per calendar day
    return {
        "delta_pnl": round(delta_pnl, 6),
        "gamma_pnl": round(gamma_pnl, 6),
        "vega_pnl":  round(vega_pnl,  6),
        "theta_pnl": round(theta_pnl, 6),
        "total_approx": round(delta_pnl + gamma_pnl + vega_pnl + theta_pnl, 6),
    }
```

---

## Common Gotchas

| Issue | Fix |
|-------|-----|
| Negative time to expiry | Guard `T > 0`; handle expiry day as `T = 1e-6` |
| Vega = 0 when deep ITM/OTM and near expiry | Newton-Raphson diverges; switch to bisection |
| BSM underprices tails | Use skew/surface adjustments (SABR, SVI) |
| Theta sign convention | Long option = negative theta (decay); short = positive |
| Dividend handling | Use continuous yield `q` for indices; discrete divs need forward adjustment |
