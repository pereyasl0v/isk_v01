import MarketCalculator from "./MarketCalculator";
import "./market.css";

// Calculators render inside the existing ISK React Router layout.
export default function MarketPage({userId,isAdmin=false}){return <div className="mc"><MarketCalculator userId={userId} isAdmin={isAdmin}/></div>}
