# CorribFlow

https://graza.github.io/CorribFlow/

This website uses publically available data from the Office of Public Works (OPW) in Ireland to provide an estimate of the current flow rate on the Corrib River in Galway. 

The OPW provides an API to fetch information about flow rates and water levels at various sites around Ireland.  Some of this sensor data is updated every 15 minutes.  Note however the data available for flow rate on the Corrib is only updated very infrequently, in the order of months.  The data that is available every 15 minutes is water level, including values relative to a datum point at Malin Head.  By correlating the available flow rate information with the difference in water level between two points, a model for the relationship between flow rate and water level difference can be created.

In the case of the Corrib, the flow rate data is available for the Wolfe Tone Bridge in town, while there are water level sensors at the salmon weir (known as Galway Barrage), the Quincentennial Bridge, Dangan, and Angligham on Lough Corrib.  Although the flow rate sensor at Wolfe Tone Bridge is downstream of the weir, it is assumed that the flow there is the same as above the weir since (a) the bridge is only 800m downstream, and (b) there are no other feeds into the river between the water level sensors and the flow rate sensor.

A linear regression approach has been used for this model.  The equation derived from the historic flow rate and water level difference information (between Galway Barrage and Angligham) is of the form:

flowrate = 254.65 * difference + 28.883

The flow rate is calculated in cubic metres per second, while the difference is in metres.

This data from OPW is available in CSV format.  What can be observed from this data is that there are rapid changes in water level difference and therefore flow rate.  This results fom the opening and closing of gates at the weir.  This opening and closing is managed by operations staff at the weir and is presumably in response to prevailing conditions on Lough Corrib and its sorrounding catchment area.

A more sophisticated model that accounts for rates of change, or uses different pairs of sensors is a topic for future study.  The data used is Irish Public Sector Information licensed under a Creative Commons Attribution 4.0 International (CC BY 4.0) licence (source http://waterlevel.ie/hydro-data/ - provided by the Office of Public Works).  The output of this website should be treated with the same attention to the possibly erroneous nature of its output as that stated in the [help](https://waterlevel.ie/hydro-data/#/html/help) and [disclaimer](https://waterlevel.ie/hydro-data/#/html/disclaimer) sections of the source.
