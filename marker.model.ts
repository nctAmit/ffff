import { Color, Entity } from "cesium";

export interface CycleData {
    latitude: number;
    longitude: number;
    name: string;             // e.g., "Asset_1"
    image: string;            // e.g., "dummy_image.png"
    asset: string;            // e.g., "DUMMY"
    date: string;             // Format: "YYYY-MM-DD"
    time: string;             // Format: "HH:MM:SS"
    assetType: string;
    color: {
        "r": number,
        "g": number,
        "b": number
    } // RGB format, e.g., [255, 0, 0]
    duration: string;         // Format: "X min Y sec"
}

export interface MarkerData {
    point: {
        lat: number;
        lng: number;
    };
    options: {
        icon: IconDetails;
        highlightIcon: IconDetails;
        color: string;
        zIndexOffset: number;
    };
    popupData: {
        [index: string]: string | number | null
    };
}

export interface IconDetails {
    url: string;
    size: {
        x: number;
        y: number;
    };
    iconAnchor: {
        x: number;
        y: number;
    };
}


export interface ClusterPillStyle {
    fontFamily?: string;
    fontPx?: number;
    paddingX?: number;
    paddingY?: number;
    textColor?: string;         // default: black
    backgroundColor?: string;   // default: whitesmoke
    separatorColor?: string;    // default: black (used in mixed case)
    maxCssWidth?: number;
    minCssWidth?: number;
    dotDiameterPx?: number;
    dotGapPx: 6,
    loadDotColor: 'rgb(152, 38, 222)',
    dumpDotColor: 'rgb(254, 90, 171)',
    // (radius/gradient/shadow omitted intentionally; we use plain rectangles now)
}

export interface ClusteredMarkersOptions {
    enabled?: boolean;
    pixelRange?: number;
    minimumClusterSize?: number;

    /**
     * Kept for compatibility but not used for the L/D choice (which is driven by segmentDesc).
     * When uniform, we always use 'L' or 'D' prefixes per your rule.
     */
    labelPrefix?: string;

    pointPixelSize?: number;
    getPointColor?: (evt: CycleData) => Color;

    // Rectangle visual style
    pillStyle?: ClusterPillStyle;

    autoZoom?: boolean;

    onMarkerClick?: (info: {
        entity: Entity;
        event: CycleData | undefined;
        lat: number;
        lon: number;
    }) => void;

    onClusterClick?: (info: {
        clusterEntity: Entity;
        members: Entity[];
        lat: number;
        lon: number;
    }) => void;

    dataSourceName?: string;
}