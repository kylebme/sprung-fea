"""Harmonic response through real CalculiX steady-state dynamics."""
import unittest, sys, tempfile, shutil, json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'engine'))
import worker
ROOT=Path(__file__).resolve().parents[1]

def study(**harmonic):
    return {'analysis':'harmonic','material':{'name':'Al','young':68900,'poisson':.33,'density':2700,'yield':276},
            'supports':[{'faces':[1],'axes':[True]*3}],'loads':[{'kind':'force','faces':[2],'vector':[0,0,-100]}],
            'masses':[],'meshSize':4,'modes':10,'harmonic':{'min':20,'max':3000,'damping':.02,'excitation':'loads',**harmonic}}

class Harmonic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        shutil.copy(ROOT/'samples/beam.step',cls.folder/'part.step')
        worker.import_part(cls.folder)
        worker.mesh_part(cls.folder,study())
        s=study();s['analysis']='static'
        cls.static=worker.solve(cls.folder,s)['summary']['maxMovement']
        s['analysis']='frequency';s['modes']=2
        cls.f1=worker.solve(cls.folder,s)['summary']['frequencies'][0]
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def response(self,result):
        c=result['charts'][0]
        return c['x']['values'],c['series'][0]['values']

    def test_tip_force_resonates_at_the_first_natural_frequency(self):
        result=worker.solve(self.folder,study())
        hz,amp=self.response(result)
        # Well below resonance the response is the static deflection.
        self.assertLess(abs(amp[0]/self.static-1),.01)
        self.assertLess(abs(result['summary']['peakFrequency']/self.f1-1),.002)
        # Amplification ≈ 1/(2ζ) = 25 at resonance for one dominant mode.
        self.assertGreater(result['summary']['peakAmplitude']/self.static,20)
        self.assertLess(result['summary']['peakAmplitude']/self.static,27)
        self.assertLessEqual(len(result['frames']),40)
        self.assertTrue(any(abs(f['value']-self.f1)<1e-2 for f in result['frames']))

    def test_damping_controls_the_peak(self):
        light=worker.solve(self.folder,study(damping=.01))['summary']['peakAmplitude']
        heavy=worker.solve(self.folder,study(damping=.02))['summary']['peakAmplitude']
        self.assertLess(abs(light/heavy-2),.2)

    def test_base_shaking_is_relative_to_the_base(self):
        result=worker.solve(self.folder,study(excitation='base',base=[0,0,1]))
        # Far below resonance, 1 g of shaking bends the beam like 1 g of
        # gravity: qL⁴/8EI at the tip.
        sag=2700e-12*200*9810*100**4/(8*68900*20*10**3/12)
        hz,amp=self.response(result)
        self.assertLess(abs(amp[0]/sag-1),.02)
        self.assertTrue(any('relative to the shaking base' in w for w in result['warnings']))

    def test_too_few_modes_are_flagged(self):
        s=study();s['modes']=1
        result=worker.solve(self.folder,s)
        self.assertTrue(any('Find more modes' in w for w in result['warnings']))

    def test_invalid_settings(self):
        mesh=json.loads((self.folder/'mesh.json').read_text())
        for harmonic,message in [({'min':500,'max':100},'above the lowest'),({'damping':0},'Damping'),
                                 ({'excitation':'base','base':[0,0,0]},'base acceleration')]:
            with self.subTest(message=message),self.assertRaisesRegex(ValueError,message):
                worker.write_deck(self.folder,study(**harmonic),mesh)

if __name__=='__main__':unittest.main()
