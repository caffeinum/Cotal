import { Composition } from "remotion";
import { PeerMesh } from "./variants/PeerMesh";
import { Observer } from "./variants/Observer";
import { WireTrace } from "./variants/WireTrace";
import { Triptych } from "./variants/Triptych";
import { MeshFrame } from "./variants/MeshFrame";
import { MeshFull } from "./variants/MeshFull";
import { MeshBanner } from "./variants/MeshBanner";
import { MeshRing } from "./variants/MeshRing";

const COMMON = { durationInFrames: 120, fps: 30, width: 1280 } as const;

export const Root: React.FC = () => {
  return (
    <>
      <Composition id="PeerMesh" component={PeerMesh} height={340} {...COMMON} />
      <Composition id="Observer" component={Observer} height={360} {...COMMON} />
      <Composition id="WireTrace" component={WireTrace} height={320} {...COMMON} />
      <Composition id="Triptych" component={Triptych} height={320} {...COMMON} />
      <Composition id="MeshFrame" component={MeshFrame} height={360} {...COMMON} />
      <Composition id="MeshFull" component={MeshFull} height={360} {...COMMON} />
      <Composition id="MeshBanner" component={MeshBanner} height={200} {...COMMON} />
      <Composition id="MeshRing" component={MeshRing} height={340} {...COMMON} />
    </>
  );
};
