import { useEffect, useState, useCallback, useRef } from 'react';
import { APIProvider, Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps';
import { useRealtimeStore } from '../store/realtime.store';
import { MapPin, Zap, TrendingUp, Navigation } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { useUIStore } from '../store/ui.store';
import { useGPSContext } from '../context/GPSContext';
import WorkerStatusBadge from '../components/WorkerStatusBadge';
import { formatCoords } from '../utils/gpsUtils';
import api from '../services/api.service';

// Default center: Mumbai
const DEFAULT_CENTER = { lat: 19.0760, lng: 72.8777 };
const REFRESH_INTERVAL = 300_000; // 5 minutes

// ── Haversine (for checking if worker is in cluster) ────────────
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Demand level → color ────────────────────────────────────────
const DEMAND_COLORS = {
    high: { fill: '#ef4444', label: '🔴', bg: 'bg-red-100 text-red-700', badge: 'bg-red-500' },
    medium: { fill: '#f97316', label: '🟠', bg: 'bg-orange-100 text-orange-700', badge: 'bg-orange-500' },
    low: { fill: '#22c55e', label: '🟢', bg: 'bg-green-100 text-green-700', badge: 'bg-green-500' },
};

// ══════════════════════════════════════════════════════════════════
//  ZoneCircle — renders a Google Maps Circle for a cluster
// ══════════════════════════════════════════════════════════════════
function ZoneCircle({ cluster, onClick }) {
    const map = useMap();
    const circleRef = useRef(null);

    useEffect(() => {
        if (!map || !window.google) return;

        const color = DEMAND_COLORS[cluster.demand_level]?.fill || '#22c55e';
        const circle = new window.google.maps.Circle({
            map,
            center: { lat: cluster.center_lat, lng: cluster.center_lng },
            radius: Math.max(cluster.radius_km * 1000, 300), // min 300m visible
            fillColor: color,
            fillOpacity: 0.25,
            strokeColor: color,
            strokeOpacity: 0.80,
            strokeWeight: 2,
            clickable: true,
        });

        circle.addListener('click', () => onClick(cluster));
        circleRef.current = circle;

        return () => {
            circle.setMap(null);
        };
    }, [map, cluster, onClick]);

    return null;
}

// ══════════════════════════════════════════════════════════════════
//  ZoneRankingPanel — top 5 clusters ranked by score
// ══════════════════════════════════════════════════════════════════
function ZoneRankingPanel({ clusters, workerCluster }) {
    const top5 = clusters.slice(0, 5);

    if (!top5.length) return null;

    return (
        <div className="bg-white rounded-xl border-[1.5px] border-gigpay-navy shadow-brutal p-3">
            <h3 className="font-syne font-bold text-sm text-gigpay-navy mb-2 flex items-center gap-1.5">
                <TrendingUp size={14} /> Top Demand Zones
            </h3>
            <div className="flex flex-col gap-1.5">
                {top5.map((c, i) => {
                    const dm = DEMAND_COLORS[c.demand_level] || DEMAND_COLORS.low;
                    const isHere = workerCluster === c.cluster_id;
                    return (
                        <div
                            key={c.cluster_id}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs
                                ${isHere ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}
                        >
                            <span className="font-bold text-gigpay-navy w-4">{i + 1}</span>
                            <span>{dm.label}</span>
                            <div className="flex-1 min-w-0">
                                <span className="font-bold text-gigpay-navy">₹{c.est_earnings_per_hr}/hr</span>
                                <span className="text-gigpay-text-muted ml-1.5">Score {c.score}</span>
                            </div>
                            {isHere && (
                                <span className="text-blue-600 font-bold flex items-center gap-0.5">
                                    <Navigation size={10} /> Here
                                </span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ══════════════════════════════════════════════════════════════════
//  MapAutoPan — Pans the map to the user's location once when found
// ══════════════════════════════════════════════════════════════════
function MapAutoPan({ location, isTracking }) {
    const map = useMap();
    const [hasPanned, setHasPanned] = useState(false);

    useEffect(() => {
        if (map && isTracking && location && !hasPanned) {
            map.panTo({ lat: location.lat, lng: location.lng });
            setHasPanned(true);
        }
    }, [map, location, isTracking, hasPanned]);

    return null;
}

// ══════════════════════════════════════════════════════════════════
//  Zones Page
// ══════════════════════════════════════════════════════════════════
const Zones = () => {
    const setActiveTab = useUIStore(state => state.setActiveTab);
    const { location, status, isTracking, error } = useGPSContext();

    // Cluster data
    const [zoneData, setZoneData] = useState(null);
    const [selectedCluster, setSelectedCluster] = useState(null);
    const [loading, setLoading] = useState(true);

    const mapCenter = location ? { lat: location.lat, lng: location.lng } : DEFAULT_CENTER;

    // Find which cluster the worker is in
    const workerClusterId = (() => {
        if (!location || !zoneData?.clusters) return null;
        for (const c of zoneData.clusters) {
            const dist = haversineKm(location.lat, location.lng, c.center_lat, c.center_lng);
            if (dist <= c.radius_km) return c.cluster_id;
        }
        return null;
    })();

    const workerZoneLabel = (() => {
        if (!isTracking || !location) return null;
        if (workerClusterId !== null) {
            const c = zoneData?.clusters?.find(x => x.cluster_id === workerClusterId);
            return c ? `Zone #${c.cluster_id + 1} · ₹${c.est_earnings_per_hr}/hr` : null;
        }
        return 'Outside zones';
    })();

    // Fetch clusters
    const fetchClusters = useCallback(async () => {
        try {
            const res = await api.get('/zones/current');
            setZoneData(res.data?.data || null);
        } catch (err) {
            console.error('Failed to fetch zones:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        setActiveTab('map');
        fetchClusters();
        const interval = setInterval(fetchClusters, REFRESH_INTERVAL);
        return () => clearInterval(interval);
    }, [setActiveTab, fetchClusters]);

    const handleCircleClick = useCallback((cluster) => {
        setSelectedCluster(prev => prev?.cluster_id === cluster.cluster_id ? null : cluster);
    }, []);

    const clusters = zoneData?.clusters || [];

    return (
        <div className="flex flex-col h-[calc(100vh-140px)] animate-fade-in -mx-4 -mt-4 relative">
            {/* Header overlay */}
            <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Badge variant="success" className="shadow-brutal bg-white border-gigpay-navy">
                        <span className="w-2 h-2 rounded-full bg-gigpay-lime mr-2 animate-pulse" />
                        Live Demand
                    </Badge>
                    {isTracking && <WorkerStatusBadge status={status} />}
                </div>

                <div className="flex items-center gap-2">
                    {isTracking && location && (
                        <div className="bg-white px-2.5 py-1 rounded-full border-[1.5px] border-gigpay-navy shadow-brutal-sm text-xs font-mono text-gigpay-text-secondary hidden sm:block">
                            {formatCoords(location.lat, location.lng)}
                        </div>
                    )}
                    {zoneData?.time_block && (
                        <div className="bg-white px-3 py-1.5 rounded-full border-[1.5px] border-gigpay-navy shadow-brutal text-sm font-bold flex items-center gap-1.5">
                            <Zap size={16} className="text-gigpay-navy" />
                            <span className="capitalize">{zoneData.time_block.replace('_', ' ')}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* GPS Error Banner */}
            {error && (
                <div className="absolute top-16 left-4 right-4 z-20 bg-red-50 rounded-xl border border-red-200 p-3 text-sm text-red-600">
                    {error}
                </div>
            )}

            {/* Selected Cluster Popup */}
            {selectedCluster && (
                <div className="absolute top-16 left-4 right-4 z-20 bg-white rounded-xl border-[1.5px] border-gigpay-navy shadow-brutal p-4">
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold text-white ${DEMAND_COLORS[selectedCluster.demand_level]?.badge}`}>
                                {selectedCluster.demand_level.toUpperCase()}
                            </span>
                            <span className="text-xs text-gigpay-text-muted">Zone #${selectedCluster.cluster_id + 1}</span>
                        </div>
                        <button onClick={() => setSelectedCluster(null)} className="text-gigpay-text-muted text-sm">✕</button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                            <p className="text-gigpay-text-muted text-xs">Est. Earnings</p>
                            <p className="font-bold text-gigpay-navy">₹{selectedCluster.est_earnings_per_hr}/hr</p>
                        </div>
                        <div>
                            <p className="text-gigpay-text-muted text-xs">Avg Orders</p>
                            <p className="font-bold text-gigpay-navy">{selectedCluster.avg_orders}/hr</p>
                        </div>
                        <div>
                            <p className="text-gigpay-text-muted text-xs">Score</p>
                            <p className="font-bold text-gigpay-navy">{selectedCluster.score}/100</p>
                        </div>
                        <div>
                            <p className="text-gigpay-text-muted text-xs">Radius</p>
                            <p className="font-bold text-gigpay-navy">{selectedCluster.radius_km} km</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Google Map */}
            <div className="flex-1 w-full bg-[#E2E8F0] relative" style={{ touchAction: 'auto' }}>
                {import.meta.env.VITE_GOOGLE_MAPS_API_KEY ? (
                    <APIProvider apiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY}>
                        <Map
                            defaultZoom={12}
                            defaultCenter={DEFAULT_CENTER}
                            mapId="gigpay_zones_map"
                            gestureHandling="greedy"
                            zoomControl={true}
                            fullscreenControl={false}
                            streetViewControl={false}
                            mapTypeControl={false}
                        >
                            <MapAutoPan location={location} isTracking={isTracking} />
                            {/* Cluster circles */}
                            {clusters.map(c => (
                                <ZoneCircle key={c.cluster_id} cluster={c} onClick={handleCircleClick} />
                            ))}

                            {/* Cluster center labels */}
                            {clusters.map(c => (
                                <AdvancedMarker key={`label-${c.cluster_id}`} position={{ lat: c.center_lat, lng: c.center_lng }}>
                                    <div
                                        onClick={() => handleCircleClick(c)}
                                        className={`px-2 py-1 rounded-lg border-2 border-gigpay-navy shadow-brutal font-bold text-xs cursor-pointer
                                            ${c.demand_level === 'high'
                                                ? 'bg-[#FF5A5F] text-white'
                                                : c.demand_level === 'medium'
                                                    ? 'bg-[#FFD166] text-gigpay-navy'
                                                    : 'bg-[#A3CE3D] text-gigpay-navy'
                                            }`}
                                    >
                                        <span className="block text-center">₹{c.est_earnings_per_hr}</span>
                                        <span className="block text-center text-[10px] opacity-80">/hr</span>
                                    </div>
                                </AdvancedMarker>
                            ))}

                            {/* Worker location — pulsing blue dot */}
                            {isTracking && location && (
                                <AdvancedMarker position={{ lat: location.lat, lng: location.lng }}>
                                    <div className="flex flex-col items-center">
                                        <div className="relative flex items-center justify-center">
                                            <div className="absolute w-8 h-8 rounded-full bg-blue-400 opacity-30 animate-ping" />
                                            <div className="w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow-lg z-10" />
                                        </div>
                                        {workerZoneLabel && (
                                            <div className="mt-1 px-2 py-0.5 bg-white rounded-full border border-gigpay-navy shadow-sm text-[10px] font-bold text-gigpay-navy whitespace-nowrap">
                                                {workerZoneLabel}
                                            </div>
                                        )}
                                    </div>
                                </AdvancedMarker>
                            )}
                        </Map>
                    </APIProvider>
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gigpay-surface bg-grid-pattern opacity-80 text-center p-6 border-b-[1.5px] border-gigpay-border">
                        <MapPin size={48} className="text-gigpay-navy-mid mb-4 opacity-50" />
                        <h3 className="font-syne font-bold text-lg text-gigpay-navy mb-2">Map Preview Ready</h3>
                        <p className="font-dm-sans text-sm text-gigpay-text-secondary">
                            Add VITE_GOOGLE_MAPS_API_KEY to your .env file to enable the interactive zone map.
                        </p>
                    </div>
                )}
            </div>

            {/* Bottom panel — ranking */}
            <div className="absolute bottom-4 left-4 right-4 z-10">
                <ZoneRankingPanel clusters={clusters} workerCluster={workerClusterId} />
            </div>
        </div>
    );
};

export default Zones;
